/**
 * The two store actions that connect the bank archive library to the app.
 *
 * `src/lib/bankTransfer.ts` had no caller at all until these existed. What
 * they add on top of it is small and all of it is easy to get wrong:
 *
 * - the filename, which is what somebody reads six months later when they are
 *   deciding whether a file holds one bank or five;
 * - the save picker, which has to be opened while the click's user activation
 *   is still valid, and whose cancellation is not an error;
 * - the deliberate *absence* of a `lastBackedUpAt` stamp, because a handful of
 *   banks is not a backup of the profile;
 * - and the refresh of the board's cached pad data, which is invisible to
 *   every test in this file — the assertion below is on a counter, while the
 *   consequence of dropping it is a pad that stays silent for the rest of the
 *   session. `e2e-tests/bank-transfer-store.spec.ts` is the half that can see
 *   that, and it is where the mutation for this line was run.
 *
 * Importing is all-or-nothing across banks (see `importBanksFromZip`), so the
 * store's job on failure is to let the error reach the caller unchanged and to
 * refresh anyway: the rollback rewrites pad rows on its way back, and a
 * rollback that itself fails leaves rows nothing in memory knows about.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BankImportResult, BankPlacement } from "@/lib/bankTransfer";
import type { TransferProgressCallback } from "@/lib/importExport";

/**
 * The loudness pipeline, stubbed: `db.ts` imports it dynamically inside
 * `addAudioFile`, and a real background analysis racing the round-trip below
 * would be a flake blamed on the fixture.
 */
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

/**
 * The library, mocked over — but only the two functions the store calls, and
 * only so the arguments they are handed can be read. The round-trip at the
 * bottom puts the real implementations back.
 */
const transfer = {
  exportBanksToZip: vi.fn(),
  importBanksFromZip: vi.fn(),
};
vi.doMock("@/lib/bankTransfer", async () => ({
  ...(await vi.importActual<typeof import("@/lib/bankTransfer")>(
    "@/lib/bankTransfer",
  )),
  ...transfer,
}));

/**
 * The profile export, mocked the same way and for one reason only: the two
 * export actions now share the save-picker dance, and the two tests at the
 * bottom of this file are what stops the sharing from changing what the
 * profile export does with it.
 */
const profileExport = { exportProfilesToZip: vi.fn() };
vi.doMock("@/lib/importExport", async () => ({
  ...(await vi.importActual<typeof import("@/lib/importExport")>(
    "@/lib/importExport",
  )),
  ...profileExport,
}));

const realTransfer =
  await vi.importActual<typeof import("@/lib/bankTransfer")>(
    "@/lib/bankTransfer",
  );

const { useProfileStore } = await import("@/store/profileStore");
const {
  addAudioFile,
  addProfile,
  getAllPageMetadataForProfile,
  getAudioFile,
  getPadConfigurationsForProfileBank,
  getProfile,
  updateProfile,
  upsertPadConfiguration,
  upsertPageMetadata,
} = await import("@/lib/db");

const state = () => useProfileStore.getState();

// --- The banks the fixtures use ---------------------------------------------
//
// A bank's identity is its `bankId` and its position is its `pageIndex`, and
// the two agree on any fixture built from `ensureDefaultBanks` — which is what
// let a position lookup pass 28 tests once. So the ids here sort as
// "0" < the UUID < "9" while the positions run UUID, "0", "9", and every
// selection below is asked for in an order that is neither.

const STINGS_ID = "3f1c9e2a-6b47-4c58-9d0e-2a7b1c4d5e6f";
const STINGS = { bankId: STINGS_ID, pageIndex: 0, name: "Stings" };
const BEDS = { bankId: "0", pageIndex: 1, name: "Beds" };
const WALKS = { bankId: "9", pageIndex: 2, name: "Walks" };

/** A sound whose bytes come from its name, so two of them are two rows. */
async function addSound(name: string): Promise<number> {
  return addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: new Blob([`the bytes of ${name}`], { type: "audio/wav" }),
  });
}

async function seedBank(
  profileId: number,
  bank: { bankId: string; pageIndex: number; name: string },
  pads: { padIndex: number; name: string; audioFileIds: number[] }[] = [],
): Promise<void> {
  await upsertPageMetadata({ ...bank, profileId, isEmergency: false });
  for (const pad of pads) {
    await upsertPadConfiguration({
      ...pad,
      profileId,
      bankId: bank.bankId,
      playbackType: "sequential",
    });
  }
}

// --- The browser the export path expects ------------------------------------

interface SaveTarget {
  chunks: Uint8Array[];
  aborted: boolean;
  handle: FileSystemFileHandle;
  picker: ReturnType<typeof vi.fn>;
}

/** A save picker that hands back a stream, and remembers what it collected. */
function installSavePicker(): SaveTarget {
  const target: SaveTarget = {
    chunks: [],
    aborted: false,
    handle: null as unknown as FileSystemFileHandle,
    picker: vi.fn(),
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      target.chunks.push(chunk);
    },
    abort() {
      target.aborted = true;
    },
  });
  target.handle = {
    createWritable: async () => writable,
  } as unknown as FileSystemFileHandle;
  target.picker = vi.fn(async () => target.handle);
  (window as unknown as Record<string, unknown>).showSaveFilePicker =
    target.picker;
  return target;
}

/** A picker that refuses, the way a cancelled or a blocked dialog does. */
function installFailingPicker(error: unknown): ReturnType<typeof vi.fn> {
  const picker = vi.fn(async () => {
    throw error;
  });
  (window as unknown as Record<string, unknown>).showSaveFilePicker = picker;
  return picker;
}

interface Download {
  blobs: Blob[];
  names: string[];
}

/** The anchor-element download, captured rather than performed. */
function captureDownloads(): Download {
  const seen: Download = { blobs: [], names: [] };
  const objectUrls = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (blob: Blob | MediaSource) => {
      const url = `blob:fake/${objectUrls.size}`;
      objectUrls.set(url, blob as Blob);
      return url;
    },
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const anchor = {
    href: "",
    download: "",
    click() {
      seen.blobs.push(objectUrls.get(anchor.href) as Blob);
      seen.names.push(anchor.download);
    },
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => anchor,
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  return seen;
}

const TODAY = new Date().toISOString().split("T")[0];

beforeEach(async () => {
  await clearAllStores();
  transfer.exportBanksToZip.mockReset();
  transfer.importBanksFromZip.mockReset();
  transfer.exportBanksToZip.mockResolvedValue(null);
  profileExport.exportProfilesToZip.mockReset();
  profileExport.exportProfilesToZip.mockResolvedValue(null);
  useProfileStore.setState({
    profiles: [],
    padConfigsVersion: 0,
    syncRequestQueue: {},
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  delete (globalThis as unknown as Record<string, unknown>).document;
  vi.restoreAllMocks();
});

describe("exportBanksToZip", () => {
  it("refuses an empty selection without opening a picker", async () => {
    const target = installSavePicker();

    expect(await state().exportBanksToZip(1, [], [])).toBe(false);

    expect(target.picker).not.toHaveBeenCalled();
    expect(transfer.exportBanksToZip).not.toHaveBeenCalled();
  });

  it("names a one-bank file after the bank itself", async () => {
    const target = installSavePicker();

    await state().exportBanksToZip(1, [STINGS_ID], ["Act 1: Stings!"]);

    expect(target.picker.mock.calls[0][0].suggestedName).toBe(
      `impamp-bank-act-1--stings--${TODAY}.iaz`,
    );
  });

  it("names a several-bank file by the count, and never after one of them", async () => {
    const target = installSavePicker();

    await state().exportBanksToZip(
      1,
      [WALKS.bankId, STINGS_ID, BEDS.bankId],
      ["Walks", "Stings", "Beds"],
    );

    // A file called impamp-bank-walks-….iaz that holds three banks is how a
    // restore goes wrong six months later.
    expect(target.picker.mock.calls[0][0].suggestedName).toBe(
      `impamp-banks-3-${TODAY}.iaz`,
    );
  });

  it("falls back to a name rather than an empty one", async () => {
    const target = installSavePicker();

    await state().exportBanksToZip(1, [STINGS_ID], [""]);

    expect(target.picker.mock.calls[0][0].suggestedName).toBe(
      `impamp-bank-bank-${TODAY}.iaz`,
    );
  });

  it("streams to the file the picker opened, in the order asked for", async () => {
    installSavePicker();
    const onProgress: TransferProgressCallback = vi.fn();

    const done = await state().exportBanksToZip(
      7,
      [WALKS.bankId, STINGS_ID, BEDS.bankId],
      ["Walks", "Stings", "Beds"],
      onProgress,
    );

    expect(done).toBe(true);
    const [profileId, bankIds, writeTarget, progress] =
      transfer.exportBanksToZip.mock.calls[0];
    expect(profileId).toBe(7);
    // Neither the positional order nor the sorted one: the selection travels
    // as the user built it, by identity.
    expect(bankIds).toEqual([WALKS.bankId, STINGS_ID, BEDS.bankId]);
    expect(writeTarget).toBeInstanceOf(WritableStream);
    expect(progress).toBe(onProgress);
  });

  it("treats a cancelled picker as no export at all", async () => {
    const picker = installFailingPicker(
      new DOMException("The user aborted a request.", "AbortError"),
    );
    const downloads = captureDownloads();

    expect(await state().exportBanksToZip(1, [STINGS_ID], ["Stings"])).toBe(
      false,
    );

    expect(picker).toHaveBeenCalled();
    expect(transfer.exportBanksToZip).not.toHaveBeenCalled();
    expect(downloads.names).toEqual([]);
  });

  it("falls back to a download when the picker fails for any other reason", async () => {
    installFailingPicker(new Error("blocked in this context"));
    const downloads = captureDownloads();
    transfer.exportBanksToZip.mockResolvedValue(new Blob(["an archive"]));

    const done = await state().exportBanksToZip(1, [STINGS_ID], ["Stings"]);

    expect(done).toBe(true);
    expect(transfer.exportBanksToZip.mock.calls[0][2]).toBe("blob");
    expect(downloads.names).toEqual([`impamp-bank-stings-${TODAY}.iaz`]);
  });

  it("takes the same fallback where there is no picker at all", async () => {
    const downloads = captureDownloads();
    transfer.exportBanksToZip.mockResolvedValue(new Blob(["an archive"]));

    expect(await state().exportBanksToZip(1, [STINGS_ID], ["Stings"])).toBe(
      true,
    );

    expect(transfer.exportBanksToZip.mock.calls[0][2]).toBe("blob");
    expect(downloads.blobs).toHaveLength(1);
  });

  it("reports a download that could not be started as a failed export", async () => {
    transfer.exportBanksToZip.mockResolvedValue(new Blob(["an archive"]));
    // No document at all, which is what `_triggerBlobDownload` catches.

    expect(await state().exportBanksToZip(1, [STINGS_ID], ["Stings"])).toBe(
      false,
    );
  });

  it("abandons the file it opened when the export fails, and says so", async () => {
    const target = installSavePicker();
    transfer.exportBanksToZip.mockRejectedValue(new Error("bank 9 is gone"));

    await expect(
      state().exportBanksToZip(1, [STINGS_ID], ["Stings"]),
    ).rejects.toThrow("bank 9 is gone");

    // A half-written archive left on disk under a name that promises a bank
    // is worse than no file: it is discovered at the far end.
    expect(target.aborted).toBe(true);
  });

  it("does not stamp the profile as backed up", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    // A time far enough back that the reminder is overdue, so a stamp written
    // here would be the difference between being nagged and not.
    const lastYear = Date.UTC(2025, 0, 2);
    await updateProfile(profileId, { lastBackedUpAt: lastYear });
    const before = await getProfile(profileId);
    useProfileStore.setState({ profiles: [before!] });
    installSavePicker();

    await state().exportBanksToZip(profileId, [STINGS_ID], ["Stings"]);

    // A selection of banks is not a backup of the profile, and a stamp here
    // silences the reminder on data nobody exported.
    expect((await getProfile(profileId))?.lastBackedUpAt).toBe(lastYear);
    expect(state().profiles[0].lastBackedUpAt).toBe(lastYear);
  });
});

describe("importBanksFromArchive", () => {
  const result: BankImportResult = {
    written: [{ folder: "0", name: "Stings", bankId: STINGS_ID, pageIndex: 4 }],
    skipped: ["Beds"],
  };
  const placements: Record<string, BankPlacement> = {
    "0": { kind: "add" },
    "1": { kind: "skip" },
    "2": { kind: "replace", bankId: BEDS.bankId },
  };

  it("hands the library the profile, the placements and the callback", async () => {
    transfer.importBanksFromZip.mockResolvedValue(result);
    const archive = new Blob(["an archive"]);
    const onProgress: TransferProgressCallback = vi.fn();

    const returned = await state().importBanksFromArchive(
      archive,
      7,
      placements,
      onProgress,
    );

    expect(returned).toEqual(result);
    const [blob, db, options, progress] =
      transfer.importBanksFromZip.mock.calls[0];
    expect(blob).toBe(archive);
    expect(db).toBeDefined();
    expect(options).toEqual({ profileId: 7, placements });
    // The very callback, not a wrapper around it: `importBanksFromZip` calls
    // it outside the write it announces, and anything this layer did inside
    // that call would be inside the write after all.
    expect(progress).toBe(onProgress);
  });

  it("refreshes the board's cached pad data", async () => {
    transfer.importBanksFromZip.mockResolvedValue(result);

    await state().importBanksFromArchive(new Blob([]), 7, placements);

    expect(state().padConfigsVersion).toBe(1);
  });

  it("refreshes it even when the import failed and was taken back", async () => {
    transfer.importBanksFromZip.mockRejectedValue(new Error("bank 2 failed"));

    await expect(
      state().importBanksFromArchive(new Blob([]), 7, placements),
    ).rejects.toThrow();

    // The rollback rewrites pad rows on its way back, and one that itself
    // fails leaves rows no cached copy knows about. "Wrote nothing" is not
    // "changed nothing".
    expect(state().padConfigsVersion).toBe(1);
  });

  it("lets the failure reach the caller with its own message", async () => {
    transfer.importBanksFromZip.mockRejectedValue(
      new Error('Bank "Beds" could not be written: audio 12 is missing'),
    );

    // One bank failing takes the whole import back, so there is no partial
    // result to report — the dialog has an error to show and nothing else.
    await expect(
      state().importBanksFromArchive(new Blob([]), 7, placements),
    ).rejects.toThrow('Bank "Beds" could not be written: audio 12 is missing');
  });

  it("asks for a sync of the profile it wrote into", async () => {
    transfer.importBanksFromZip.mockResolvedValue(result);

    await state().importBanksFromArchive(new Blob([]), 7, placements);

    expect(Object.keys(state().syncRequestQueue)).toEqual(["7"]);
  });

  it("asks for no sync when the import was taken back", async () => {
    transfer.importBanksFromZip.mockRejectedValue(new Error("bank 2 failed"));

    await expect(
      state().importBanksFromArchive(new Blob([]), 7, placements),
    ).rejects.toThrow();

    // A rollback puts back the rows it took, so there is nothing new to
    // publish; and if the rollback failed too, the user is about to be told
    // so rather than have the mess pushed to their other devices.
    expect(state().syncRequestQueue).toEqual({});
  });
});

/**
 * The neighbour this task refactored.
 *
 * Nothing else in the unit suite drives it, and it is the only caller of the
 * save-picker dance that is meant to stamp a backup — so these two are here to
 * keep the sharing honest rather than because the bank export needs them.
 */
describe("exportMultipleProfilesToZip", () => {
  async function seedProfile(lastBackedUpAt: number): Promise<number> {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await updateProfile(profileId, { lastBackedUpAt });
    useProfileStore.setState({ profiles: [(await getProfile(profileId))!] });
    return profileId;
  }

  it("stamps the profile as backed up once the archive is on disk", async () => {
    const profileId = await seedProfile(Date.UTC(2025, 0, 2));
    installSavePicker();

    expect(await state().exportMultipleProfilesToZip([profileId])).toBe(true);

    expect((await getProfile(profileId))?.lastBackedUpAt).toBeGreaterThan(
      Date.UTC(2026, 0, 1),
    );
  });

  it("stamps nothing and reports nothing when the dialog is cancelled", async () => {
    const lastYear = Date.UTC(2025, 0, 2);
    const profileId = await seedProfile(lastYear);
    installFailingPicker(
      new DOMException("The user aborted a request.", "AbortError"),
    );
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await state().exportMultipleProfilesToZip([profileId])).toBe(false);

    // A cancel is not a failure. It used to return before the console.error
    // that a failed download earns, and it still must.
    expect((await getProfile(profileId))?.lastBackedUpAt).toBe(lastYear);
    expect(complaints).not.toHaveBeenCalled();
  });
});

describe("through the real library", () => {
  beforeEach(() => {
    transfer.exportBanksToZip.mockImplementation(realTransfer.exportBanksToZip);
    transfer.importBanksFromZip.mockImplementation(
      realTransfer.importBanksFromZip,
    );
  });

  it("round-trips the banks that were asked for, by identity, into another profile", async () => {
    const source = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    const bed = await addSound("bed");
    const walk = await addSound("walk");
    // Byte-identical sounds are one row after deduplication, and a fixture
    // that cannot tell three sounds apart cannot tell three banks apart.
    expect(new Set([sting, bed, walk]).size).toBe(3);
    await seedBank(source, STINGS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);
    await seedBank(source, BEDS, [
      { padIndex: 5, name: "Rain", audioFileIds: [bed] },
    ]);
    await seedBank(source, WALKS, [
      { padIndex: 9, name: "Gravel", audioFileIds: [walk] },
    ]);

    const target = installSavePicker();
    const done = await state().exportBanksToZip(
      source,
      [WALKS.bankId, STINGS_ID],
      ["Walks", "Stings"],
    );
    expect(done).toBe(true);
    const archive = new Blob(target.chunks as BlobPart[]);

    // The archive holds the two banks that were named, in the order they were
    // named — not the two at those positions, and not "Beds" at all.
    const described = await realTransfer.readArchiveManifest(archive);
    expect(described).toEqual({
      kind: "banks",
      banks: [
        expect.objectContaining({ folder: "0", name: "Walks" }),
        expect.objectContaining({ folder: "1", name: "Stings" }),
      ],
    });

    const destination = await addProfile({ name: "Show B", syncType: "local" });
    await seedBank(destination, { ...BEDS, pageIndex: 0 });

    const imported = await state().importBanksFromArchive(
      archive,
      destination,
      {
        "0": { kind: "add" },
        "1": { kind: "replace", bankId: BEDS.bankId },
      },
    );

    expect(imported.written.map((bank) => bank.name)).toEqual([
      "Walks",
      "Stings",
    ]);
    expect(imported.skipped).toEqual([]);

    const pages = await getAllPageMetadataForProfile(destination);
    expect(pages.map((page) => page.name).sort()).toEqual(["Stings", "Walks"]);
    // The replaced bank keeps the destination's identity; the added one is
    // given a fresh id rather than the source's.
    const replaced = pages.find((page) => page.bankId === BEDS.bankId);
    expect(replaced?.name).toBe("Stings");
    const added = pages.find((page) => page.bankId !== BEDS.bankId);
    expect(added?.bankId).not.toBe(WALKS.bankId);

    // "Stings" replaced the destination's own bank, so its pad is under that
    // bank's id — the destination's identity, never the source's.
    const replacedPads = await getPadConfigurationsForProfileBank(
      destination,
      BEDS.bankId,
    );
    expect(replacedPads.map((pad) => pad.name)).toEqual(["Horn"]);
    const addedPads = await getPadConfigurationsForProfileBank(
      destination,
      added!.bankId,
    );
    expect(addedPads.map((pad) => pad.name)).toEqual(["Gravel"]);
    // The bytes arrived, not just the reference.
    const row = await getAudioFile(replacedPads[0].audioFileIds![0]);
    expect(await row?.blob.text()).toBe("the bytes of sting");

    // And the board is told, which is the only reason any of it is on screen.
    expect(state().padConfigsVersion).toBe(1);
  });
});
