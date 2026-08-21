/**
 * Collecting one bank for a `.iaz` archive.
 *
 * Three rules decide the shape, and each is easy to get backwards.
 *
 * A bank's identity is `bankId`; its position is `pageIndex`. The collector is
 * asked for an identity, so every fixture here puts a bank at a position that
 * is not its id — a fixture where the two agree lets a position-keyed
 * implementation pass everything, which is the 28-green-tests swap CLAUDE.md
 * records.
 *
 * An archive is a document, not a sync event. It carries a bank's content and
 * nothing that says where that content lived (`id`, `profileId`, `bankId`,
 * `pageIndex`) or when some other device last edited it (`_created`,
 * `_modified`, `_fieldsModified`).
 *
 * And audio is collected per row, not per reference. Since audio is
 * deduplicated by content hash, one pad may legitimately name one row twice
 * and two pads may name the same row — the archive carries those bytes once.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration, PlaybackType } from "./db";

/**
 * The loudness pipeline, stubbed.
 *
 * `db.ts` imports it dynamically inside `addAudioFile`, so `vi.doMock`
 * registered here — before `db.ts` is imported — is what that import
 * resolves to. Two tests below turn on whether a row carries an analysis, and
 * a real background analysis racing them would be a flake blamed on the
 * fixture.
 */
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

const { collectBankDataForZip, exportBanksToZip } =
  await import("./bankTransfer");
const {
  addAudioFile,
  addProfile,
  getDb,
  updateAudioFileLoudness,
  upsertPadConfiguration,
  upsertPageMetadata,
} = await import("./db");
const { LOUDNESS_ALGO_VERSION } = await import("./audio/loudness/constants");

/**
 * A sound whose bytes are derived from its name.
 *
 * Four people on this branch have been caught by a fixture whose "different"
 * sounds were byte-identical: dedup then collapses them into one row and the
 * test is measuring something else entirely. Every caller asserts the ids
 * differ.
 */
async function addSound(
  name: string,
  bytes: string = `the bytes of ${name}`,
): Promise<number> {
  return addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: new Blob([bytes], { type: "audio/wav" }),
  });
}

type SeedPad = Omit<
  PadConfiguration,
  | "id"
  | "profileId"
  | "bankId"
  | "createdAt"
  | "updatedAt"
  | "_created"
  | "_modified"
  | "_fieldsModified"
  | "playbackType"
> & { playbackType?: PlaybackType };

async function seedBank(
  profileId: number,
  bank: {
    bankId: string;
    pageIndex: number;
    name: string;
    isEmergency?: boolean;
  },
  pads: SeedPad[] = [],
): Promise<void> {
  await upsertPageMetadata({
    profileId,
    bankId: bank.bankId,
    pageIndex: bank.pageIndex,
    name: bank.name,
    isEmergency: bank.isEmergency ?? false,
  });

  for (const pad of pads) {
    await upsertPadConfiguration({
      profileId,
      bankId: bank.bankId,
      playbackType: "sequential",
      ...pad,
    });
  }
}

/**
 * Two banks whose ids and positions deliberately disagree.
 *
 * `"0"` — a perfectly ordinary id, since a migrated or default bank takes
 * `String(pageIndex)` — sits at position 1, and a UUID sits at position 0. A
 * collector that looked banks up by position would hand back "Stings" when
 * asked for `"0"`, and nothing at all when asked for the UUID.
 */
const OPENERS_ID = "3f1c9e2a-6b47-4c58-9d0e-2a7b1c4d5e6f";
const OPENERS = {
  bankId: OPENERS_ID,
  pageIndex: 0,
  name: "Stings",
  isEmergency: true,
} as const;
const CLOSERS = {
  bankId: "0",
  pageIndex: 1,
  name: "Beds",
  isEmergency: false,
} as const;

/**
 * A third bank, so that "the order asked for" is testable at all.
 *
 * With two banks there are only two possible orders, and the positional one
 * and the sorted one are the two — so every mutation of the ordering rule
 * lands on an order some other rule also produces. Three banks whose ids sort
 * as `"0"` < the UUID < `"9"` while their positions run UUID, `"0"`, `"9"`
 * give an argument order that is neither.
 */
const WALKS = {
  bankId: "9",
  pageIndex: 2,
  name: "Walks",
  isEmergency: false,
} as const;

/**
 * The standard pair, one pad and one sound each.
 *
 * Returns the two audio ids, having first proved they are two: the sounds'
 * bytes differ, so deduplication by content hash cannot quietly make them one
 * row and leave the test measuring something else.
 */
async function seedTwoBanks(
  profileId: number,
): Promise<{ sting: number; bed: number }> {
  const sting = await addSound("sting");
  const bed = await addSound("bed");
  expect(sting).not.toBe(bed);

  await seedBank(profileId, OPENERS, [
    { padIndex: 0, name: "Horn", audioFileIds: [sting] },
  ]);
  await seedBank(profileId, CLOSERS, [
    { padIndex: 5, name: "Rain", audioFileIds: [bed] },
  ]);

  return { sting, bed };
}

beforeEach(async () => {
  await clearAllStores();
});

describe("collectBankDataForZip", () => {
  it("collects the bank with that identity, not the bank at that position", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { sting, bed } = await seedTwoBanks(profileId);

    const byUuid = await collectBankDataForZip(profileId, OPENERS_ID);
    expect(byUuid.bank.page.name).toBe("Stings");
    expect(byUuid.bank.padConfigurations.map((pad) => pad.name)).toEqual([
      "Horn",
    ]);
    expect(byUuid.bank.audioFiles.map((ref) => ref.id)).toEqual([sting]);

    // The bank whose id is "0" sits at position 1, and the bank at position 0
    // is the other one. Only an identity lookup answers this correctly.
    const byDigit = await collectBankDataForZip(profileId, "0");
    expect(byDigit.bank.page.name).toBe("Beds");
    expect(byDigit.bank.padConfigurations.map((pad) => pad.name)).toEqual([
      "Rain",
    ]);
    expect(byDigit.bank.audioFiles.map((ref) => ref.id)).toEqual([bed]);
  });

  it("names the archive version, the source bank and the source profile", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedBank(profileId, OPENERS);

    const { bank, sourceProfileName } = await collectBankDataForZip(
      profileId,
      OPENERS_ID,
    );

    // Task 10 routes an archive on this number alone, so a profile archive
    // (version 3) and a bank archive must never share one.
    expect(bank.exportVersion).toBe(4);
    expect(bank.sourceBankId).toBe(OPENERS_ID);
    expect(sourceProfileName).toBe("Show A");
    expect(Date.parse(bank.exportDate)).not.toBeNaN();
  });

  it("carries the bank's own settings rather than a default", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedBank(profileId, OPENERS);
    await seedBank(profileId, CLOSERS);

    const emergency = await collectBankDataForZip(profileId, OPENERS_ID);
    const ordinary = await collectBankDataForZip(profileId, "0");

    expect(emergency.bank.page.name).toBe("Stings");
    expect(emergency.bank.page.isEmergency).toBe(true);
    expect(ordinary.bank.page.name).toBe("Beds");
    expect(ordinary.bank.page.isEmergency).toBe(false);
  });

  it("drops the identity, the position and the sync stamps from every row", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    // The fixture must actually carry what the export is meant to drop, or
    // the assertions below hold for the wrong reason.
    const db = await getDb();
    for (const stored of [
      (await db.getAll("padConfigurations"))[0],
      (await db.getAll("pageMetadata"))[0],
    ]) {
      expect(stored.id).toBeDefined();
      expect(stored._created).toBeDefined();
      expect(stored._modified).toBeDefined();
      expect(stored._fieldsModified).toBeDefined();
    }

    const { bank } = await collectBankDataForZip(profileId, OPENERS_ID);
    const page = bank.page as Record<string, unknown>;
    const pad = bank.padConfigurations[0] as Record<string, unknown>;

    for (const field of [
      "id",
      "profileId",
      "bankId",
      "pageIndex",
      "_created",
      "_modified",
      "_fieldsModified",
    ]) {
      expect(page).not.toHaveProperty(field);
      expect(pad).not.toHaveProperty(field);
    }
  });

  it("carries every playback setting a pad holds, including the ones keyed by audio id", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      {
        padIndex: 7,
        name: "Horn",
        keyBinding: "q",
        audioFileIds: [sting],
        audioTrimSettings: { [sting]: { trimStart: 0.25, trimEnd: 1.75 } },
        audioGainSettings: { [sting]: -4.5 },
        padGainDb: 2,
        playbackType: "round-robin",
        isDisabled: true,
        activePadBehavior: "layer",
      },
    ]);

    const { bank } = await collectBankDataForZip(profileId, OPENERS_ID);
    const [pad] = bank.padConfigurations;

    expect(pad.padIndex).toBe(7);
    expect(pad.name).toBe("Horn");
    expect(pad.keyBinding).toBe("q");
    expect(pad.audioFileIds).toEqual([sting]);
    expect(pad.audioTrimSettings).toEqual({
      [sting]: { trimStart: 0.25, trimEnd: 1.75 },
    });
    expect(pad.audioGainSettings).toEqual({ [sting]: -4.5 });
    expect(pad.padGainDb).toBe(2);
    expect(pad.playbackType).toBe("round-robin");
    expect(pad.isDisabled).toBe(true);
    expect(pad.activePadBehavior).toBe("layer");
  });

  it("leaves an absent per-pad behaviour absent, so it follows the importing profile", async () => {
    const profileId = await addProfile({
      name: "Show A",
      syncType: "local",
      activePadBehavior: "restart",
    });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    const { bank } = await collectBankDataForZip(profileId, OPENERS_ID);

    // Resolving it here would freeze the exporting profile's setting onto
    // every imported pad — the importing profile's setting would never apply.
    expect(bank.padConfigurations[0].activePadBehavior).toBeUndefined();
  });

  it("carries one entry for a sound the bank names several times", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const horn = await addSound("horn");
    const stab = await addSound("stab");
    expect(horn).not.toBe(stab);

    await seedBank(profileId, OPENERS, [
      // Naming one row twice is legitimate since audio is deduplicated by
      // content hash: adding the same file to a pad twice reuses the row.
      { padIndex: 0, name: "Double", audioFileIds: [horn, horn] },
      { padIndex: 1, name: "Pair", audioFileIds: [horn, stab] },
    ]);

    const { bank, audioBlobs } = await collectBankDataForZip(
      profileId,
      OPENERS_ID,
    );

    expect(bank.audioFiles.map((ref) => ref.id)).toEqual([horn, stab]);
    expect([...audioBlobs.keys()]).toEqual([horn, stab]);
    // The pad keeps both references. Collapsing them here would drop a slot
    // from a sequential pad and a layer from a layered one.
    expect(bank.padConfigurations[0].audioFileIds).toEqual([horn, horn]);
  });

  it("leaves the profile's other banks out entirely", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { bed } = await seedTwoBanks(profileId);
    // A second pad in the other bank, so a collector that ranged the whole
    // profile would come back with three pads rather than two.
    await seedBank(profileId, CLOSERS, [
      { padIndex: 6, name: "Wind", audioFileIds: [bed] },
    ]);

    const { bank, audioBlobs } = await collectBankDataForZip(
      profileId,
      OPENERS_ID,
    );

    expect(bank.padConfigurations).toHaveLength(1);
    expect(bank.audioFiles).toHaveLength(1);
    expect(audioBlobs.has(bed)).toBe(false);
  });

  it("leaves another profile's banks out, even when they share an id", async () => {
    const mine = await addProfile({ name: "Show A", syncType: "local" });
    const theirs = await addProfile({ name: "Show B", syncType: "local" });
    const sting = await addSound("sting");
    const bed = await addSound("bed");
    expect(sting).not.toBe(bed);

    // The same bank id in two profiles. Bank ids are only unique *within* a
    // profile: every default bank on every profile is "0".."9".
    //
    // The other profile's copy is written first on purpose. A lookup that
    // ignored `profileId` and took the first row with a matching id would
    // otherwise still find the right bank, because IndexedDB hands rows back
    // in key order and this profile's was inserted first — a fixture that
    // cannot exhibit the failure it is named for.
    await seedBank(theirs, { ...OPENERS, name: "Someone else's" }, [
      { padIndex: 4, name: "Rain", audioFileIds: [bed] },
    ]);
    await seedBank(mine, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    const { bank, audioBlobs } = await collectBankDataForZip(mine, OPENERS_ID);

    expect(bank.page.name).toBe("Stings");
    expect(bank.padConfigurations.map((pad) => pad.name)).toEqual(["Horn"]);
    expect(audioBlobs.has(bed)).toBe(false);
  });

  it("carries the blob, the name, the type, the hash and the analysis of each sound", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await updateAudioFileLoudness(sting, {
      algoVersion: LOUDNESS_ALGO_VERSION,
      sampleRate: 48000,
      duration: 1.5,
      blockMeanSquare: new Float32Array([0.25, 0.5]),
      hopTruePeak: new Float32Array([0.75]),
    });
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    const { bank, audioBlobs } = await collectBankDataForZip(
      profileId,
      OPENERS_ID,
    );
    const [ref] = bank.audioFiles;

    expect(ref.name).toBe("sting.wav");
    expect(ref.type).toBe("audio/wav");
    // A record that lands hashless makes the next sync that needs a hash
    // SHA-256 every file in the library to build a fallback index.
    const db = await getDb();
    const stored = await db.get("audioFiles", sting);
    expect(stored?.hash).toBeTruthy();
    expect(ref.hash).toBe(stored?.hash);
    expect(ref.loudness?.algoVersion).toBe(LOUDNESS_ALGO_VERSION);
    expect(ref.loudness?.duration).toBe(1.5);

    const carried = audioBlobs.get(sting);
    expect(carried?.name).toBe("sting.wav");
    expect(carried?.type).toBe("audio/wav");
    expect(await carried?.blob.text()).toBe("the bytes of sting");
  });

  it("carries no analysis for a sound that has not been analysed", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    const { bank } = await collectBankDataForZip(profileId, OPENERS_ID);

    expect(bank.audioFiles[0].loudness).toBeUndefined();
  });

  it("skips a reference whose audio row is gone rather than failing the export", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const horn = await addSound("horn");
    const stab = await addSound("stab");
    expect(horn).not.toBe(stab);

    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Pair", audioFileIds: [horn, stab] },
    ]);
    const db = await getDb();
    await db.delete("audioFiles", stab);

    const { bank, audioBlobs } = await collectBankDataForZip(
      profileId,
      OPENERS_ID,
    );

    expect(bank.audioFiles.map((ref) => ref.id)).toEqual([horn]);
    expect([...audioBlobs.keys()]).toEqual([horn]);
    // The pad keeps the reference it had; the importer drops ids it cannot
    // map, and an export is not the place to rewrite a user's pad.
    expect(bank.padConfigurations[0].audioFileIds).toEqual([horn, stab]);
  });

  it("refuses a bank the profile does not have", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedBank(profileId, OPENERS);

    await expect(collectBankDataForZip(profileId, "nope")).rejects.toThrow(
      /bank/i,
    );
  });

  it("refuses a profile that does not exist", async () => {
    // Names the id, not merely the word "profile": the bank guard's message
    // is "Bank <id> not found in profile 4242", so a bare /profile/i passes
    // whether or not the profile is checked at all. Deleting the profile
    // guard left this test green until it was tightened.
    await expect(collectBankDataForZip(4242, OPENERS_ID)).rejects.toThrow(
      /profile with id 4242/i,
    );
  });
});

/** One entry read back out of an archive. */
interface ArchiveEntry {
  text: string;
  uncompressedSize: number;
  compressedSize: number;
}

/**
 * Reads an archive Blob back into its entries.
 *
 * Everything is pulled inside the reader's scope: `getData` needs the reader
 * still open, and a helper that returned entry handles would hand back
 * objects that throw the moment it closed.
 */
async function readArchive(archive: Blob): Promise<Map<string, ArchiveEntry>> {
  const zipjs = await import("@zip.js/zip.js");
  zipjs.configure({ useWebWorkers: false });
  const reader = new zipjs.ZipReader(new zipjs.BlobReader(archive));
  try {
    const entries = new Map<string, ArchiveEntry>();
    for (const entry of await reader.getEntries()) {
      // A directory entry has no `getData`. This writer creates none, and
      // `entries` not growing one is part of what the name assertions check.
      if (entry.directory) continue;
      entries.set(entry.filename, {
        text: await entry.getData(new zipjs.TextWriter()),
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
      });
    }
    return entries;
  } finally {
    await reader.close();
  }
}

/** The entry names an archive holds, sorted so a comparison is stable. */
async function entryNames(archive: Blob): Promise<string[]> {
  return [...(await readArchive(archive)).keys()].sort();
}

function parseEntry(entries: Map<string, ArchiveEntry>, path: string): unknown {
  const entry = entries.get(path);
  expect(entry, `archive has no ${path}`).toBeDefined();
  return JSON.parse(entry!.text);
}

/**
 * Two banks that share one sound, plus a second sound only one of them has.
 *
 * Three references across two banks and two rows, so a count taken per bank
 * differs from a count taken per row — which is the whole point of the shared
 * `audio/` folder.
 */
async function seedTwoBanksSharingASound(
  profileId: number,
  sharedBytes?: string,
  ownBytes?: string,
): Promise<{ shared: number; bedsOwn: number }> {
  const shared = await addSound("shared", sharedBytes);
  const bedsOwn = await addSound("bedsOwn", ownBytes);
  expect(shared).not.toBe(bedsOwn);

  await seedBank(profileId, OPENERS, [
    { padIndex: 0, name: "Horn", audioFileIds: [shared] },
  ]);
  await seedBank(profileId, CLOSERS, [
    { padIndex: 5, name: "Rain", audioFileIds: [shared, bedsOwn] },
  ]);

  return { shared, bedsOwn };
}

describe("exportBanksToZip", () => {
  it("writes a manifest, one entry per bank and one shared audio folder", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { sting, bed } = await seedTwoBanks(profileId);

    const archive = await exportBanksToZip(
      profileId,
      [OPENERS_ID, "0"],
      "blob",
    );

    expect(archive).toBeInstanceOf(Blob);
    // An exact set rather than a `toContain` sweep: what a reader of this
    // format may reject depends on there being nothing else in here.
    expect(await entryNames(archive!)).toEqual(
      [
        "manifest.json",
        "banks/0/bank.json",
        "banks/1/bank.json",
        `audio/${sting}`,
        `audio/${bed}`,
      ].sort(),
    );
  });

  it("writes the banks in the order asked for, not the order they sit in", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedTwoBanks(profileId);
    await seedBank(profileId, WALKS);

    // Neither the positional order (Stings, Beds, Walks) nor the sorted one
    // (Beds, Stings, Walks). A writer that collected by position, sorted the
    // selection, or numbered its folders independently of the manifest
    // disagrees with the assertions below.
    const archive = await exportBanksToZip(
      profileId,
      ["9", OPENERS_ID, "0"],
      "blob",
    );
    const entries = await readArchive(archive!);
    const manifest = parseEntry(entries, "manifest.json") as {
      exportVersion: number;
      exportDate: string;
      banks: { name: string; folder: string; sourceProfileName: string }[];
    };

    expect(manifest.exportVersion).toBe(4);
    expect(Date.parse(manifest.exportDate)).not.toBeNaN();
    expect(manifest.banks).toEqual([
      { name: "Walks", folder: "0", sourceProfileName: "Show A" },
      { name: "Stings", folder: "1", sourceProfileName: "Show A" },
      { name: "Beds", folder: "2", sourceProfileName: "Show A" },
    ]);

    // The manifest is the only route to a bank entry, so the folder it names
    // has to be the folder that bank was written to.
    for (const listed of manifest.banks) {
      const bank = parseEntry(entries, `banks/${listed.folder}/bank.json`) as {
        page: { name: string };
      };
      expect(bank.page.name).toBe(listed.name);
    }
    expect(
      ["0", "1", "2"].map(
        (folder) =>
          (
            parseEntry(entries, `banks/${folder}/bank.json`) as {
              sourceBankId: string;
            }
          ).sourceBankId,
      ),
    ).toEqual(["9", OPENERS_ID, "0"]);
  });

  it("stores a sound two banks share once, and leaves both banks naming it", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { shared, bedsOwn } = await seedTwoBanksSharingASound(profileId);

    const archive = await exportBanksToZip(
      profileId,
      [OPENERS_ID, "0"],
      "blob",
    );
    const entries = await readArchive(archive!);

    expect(
      [...entries.keys()].filter((n) => n.startsWith("audio/")).sort(),
    ).toEqual([`audio/${shared}`, `audio/${bedsOwn}`].sort());
    // Sharing the bytes must not cost the second bank its reference: each
    // bank.json still has to stand alone once it is written into a profile.
    for (const folder of ["0", "1"]) {
      const bank = parseEntry(entries, `banks/${folder}/bank.json`) as {
        audioFiles: { id: number }[];
      };
      expect(bank.audioFiles.map((ref) => ref.id)).toContain(shared);
    }
  });

  it("writes each sound's own bytes under its own id", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { sting, bed } = await seedTwoBanks(profileId);

    const archive = await exportBanksToZip(
      profileId,
      [OPENERS_ID, "0"],
      "blob",
    );
    const entries = await readArchive(archive!);

    expect(entries.get(`audio/${sting}`)?.text).toBe("the bytes of sting");
    expect(entries.get(`audio/${bed}`)?.text).toBe("the bytes of bed");
  });

  it("writes the collected bank, and an audio entry for every reference it lists", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      {
        padIndex: 7,
        name: "Horn",
        keyBinding: "q",
        audioFileIds: [sting],
        audioGainSettings: { [sting]: -4.5 },
      },
    ]);

    const archive = await exportBanksToZip(profileId, [OPENERS_ID], "blob");
    const entries = await readArchive(archive!);
    const bank = parseEntry(entries, "banks/0/bank.json") as {
      exportVersion: number;
      sourceBankId: string;
      page: Record<string, unknown>;
      padConfigurations: Record<string, unknown>[];
      audioFiles: { id: number; name: string; type: string; hash?: string }[];
    };

    expect(bank.exportVersion).toBe(4);
    expect(bank.sourceBankId).toBe(OPENERS_ID);
    expect(bank.page.name).toBe("Stings");
    expect(bank.page.isEmergency).toBe(true);
    expect(bank.padConfigurations[0].padIndex).toBe(7);
    expect(bank.padConfigurations[0].keyBinding).toBe("q");
    expect(bank.padConfigurations[0].audioGainSettings).toEqual({
      [sting]: -4.5,
    });
    expect(bank.audioFiles[0].name).toBe("sting.wav");
    expect(bank.audioFiles[0].hash).toBeTruthy();

    // Writing the stored rows rather than the collected ones would put this
    // device's keys and another device's per-field sync stamps in the file.
    for (const field of [
      "id",
      "profileId",
      "bankId",
      "pageIndex",
      "_created",
      "_modified",
      "_fieldsModified",
    ]) {
      expect(bank.page).not.toHaveProperty(field);
      expect(bank.padConfigurations[0]).not.toHaveProperty(field);
    }

    // The one guarantee a reader most wants: every reference has bytes.
    for (const ref of bank.audioFiles) {
      expect(entries.has(`audio/${ref.id}`)).toBe(true);
    }
  });

  it("counts the deduplicated audio, not one total per bank", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    // 300 + 50 bytes, so the byte total below can only come from the two
    // rows and never from three references.
    await seedTwoBanksSharingASound(profileId, "s".repeat(300), "b".repeat(50));

    const seen: {
      phase: string;
      processedFiles: number;
      totalFiles: number;
      processedBytes: number;
      totalBytes: number;
    }[] = [];
    await exportBanksToZip(profileId, [OPENERS_ID, "0"], "blob", (progress) =>
      seen.push({ ...progress }),
    );

    expect(seen[0].phase).toBe("preparing");
    const last = seen[seen.length - 1];
    expect(last.phase).toBe("finalizing");
    // Three references across the two banks, two rows: a per-bank count says
    // three, and a progress bar that never reaches its end is the symptom.
    expect(last.totalFiles).toBe(2);
    expect(last.processedFiles).toBe(2);
    expect(last.totalBytes).toBe(350);
    expect(last.processedBytes).toBe(350);
    expect(seen.some((p) => p.phase === "audio")).toBe(true);
  });

  it("streams into a WritableStream and returns no Blob", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const { sting } = await seedTwoBanks(profileId);

    const chunks: Uint8Array[] = [];
    const target = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const returned = await exportBanksToZip(profileId, [OPENERS_ID], target);

    // The File System Access path streams to disk; holding the archive in
    // memory as well would defeat the reason it exists.
    expect(returned).toBeNull();
    const streamed = new Blob(chunks as BlobPart[]);
    expect(await entryNames(streamed)).toEqual(
      ["manifest.json", "banks/0/bank.json", `audio/${sting}`].sort(),
    );
  });

  it("stores the audio rather than deflating it, and deflates the metadata", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    // Bytes that DEFLATE would crush, so "stored" is unmistakable.
    const sting = await addSound("sting", "a".repeat(4096));
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);

    const archive = await exportBanksToZip(profileId, [OPENERS_ID], "blob");
    const entries = await readArchive(archive!);

    // Real audio is compressed already, so DEFLATE costs UI-blocking time for
    // nothing; JSON is the opposite case.
    const audio = entries.get(`audio/${sting}`)!;
    expect(audio.uncompressedSize).toBe(4096);
    expect(audio.compressedSize).toBe(audio.uncompressedSize);
    const manifest = entries.get("manifest.json")!;
    expect(manifest.compressedSize).toBeLessThan(manifest.uncompressedSize);
  });

  it("fails rather than writing an archive missing a bank that was asked for", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedTwoBanks(profileId);

    // The profile export warns and carries on, because a whole-library backup
    // is worth having with one profile missing. A bank selection is a handful
    // of banks named by hand, and an archive quietly short of one of them is
    // discovered at the other end, on the night.
    await expect(
      exportBanksToZip(profileId, [OPENERS_ID, "nope"], "blob"),
    ).rejects.toThrow(/nope/);
  });

  it("does not claim the profile has been backed up", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedTwoBanks(profileId);
    const db = await getDb();
    const before = (await db.get("profiles", profileId))?.lastBackedUpAt;

    await exportBanksToZip(profileId, [OPENERS_ID], "blob");

    // A selection of banks is not a backup of the profile, and stamping it
    // would silence the reminder on data nobody exported.
    expect((await db.get("profiles", profileId))?.lastBackedUpAt).toBe(before);
  });

  it("writes an empty archive rather than throwing when nothing is selected", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedTwoBanks(profileId);

    const archive = await exportBanksToZip(profileId, [], "blob");
    const entries = await readArchive(archive!);

    expect([...entries.keys()]).toEqual(["manifest.json"]);
    expect(
      (parseEntry(entries, "manifest.json") as { banks: unknown[] }).banks,
    ).toEqual([]);
  });
});
