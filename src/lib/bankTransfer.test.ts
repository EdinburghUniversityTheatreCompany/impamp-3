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
import { makeArchive } from "@/lib/testSupport/zipArchive";
import type { PadConfiguration, PlaybackType } from "./db";
import type { BankExport, BankExportPad } from "./bankTransfer";
import type { TransferProgress } from "./importExport";
import { MAX_BANKS, TOTAL_PADS } from "./constants";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

/**
 * The loudness pipeline, stubbed.
 *
 * `db.ts` imports it dynamically inside `addAudioFile`, so `vi.doMock`
 * registered here — before `db.ts` is imported — is what that import
 * resolves to. Two tests below turn on whether a row carries an analysis, and
 * a real background analysis racing them would be a flake blamed on the
 * fixture.
 */
stubLoudnessPipeline();

const {
  collectBankDataForZip,
  exportBanksToZip,
  importBanksFromZip,
  readArchiveManifest,
  writeBankIntoProfile,
} = await import("./bankTransfer");
const {
  addAudioFile,
  addProfile,
  cleanupOrphanedAudioFiles,
  computeBlobHash,
  deleteProfile,
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

/**
 * Everything below is the other side of the module comment's list: the reader
 * of an archive nobody here wrote.
 *
 * `readArchiveManifest` is the first code in this feature to parse a file the
 * user picked, so the tests that matter are the malformed ones. Two of them
 * hold even for archives `exportBanksToZip` produces — an id in `audioFiles`
 * with no bytes behind it, and a pad naming an id `audioFiles` never declares
 * — because `collectAudioForPads` skips a dead row and leaves the pad's
 * reference alone.
 */

const EXPORT_DATE = "2026-08-19T00:00:00.000Z";

/** A manifest listing exactly the bank entries given. */
function manifestJson(banks: unknown[]): string {
  return JSON.stringify({ exportVersion: 4, exportDate: EXPORT_DATE, banks });
}

/** A well-formed `bank.json`, with any field replaced. */
function bankJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    exportVersion: 4,
    exportDate: EXPORT_DATE,
    sourceBankId: "b1",
    page: { name: "Stings", isEmergency: false },
    padConfigurations: [],
    audioFiles: [],
    ...overrides,
  });
}

/** The manifest entry the writer produces for a single bank at folder 0. */
const LISTED_BANK = {
  name: "Stings",
  folder: "0",
  sourceProfileName: "Show A",
};

/** A one-bank archive whose two documents can each be replaced. */
function oneBankArchive(
  listed: unknown = LISTED_BANK,
  bank: string = bankJson(),
): Promise<Blob> {
  return makeArchive({
    "manifest.json": manifestJson([listed]),
    "banks/0/bank.json": bank,
  });
}

/**
 * Three banks that differ in every field a summary reports.
 *
 * A fixture of one bank — or of three identical ones — cannot tell "read the
 * bank this manifest entry names" from "read the first bank in the archive",
 * which is the mistake worth catching. So the pad counts run 1, 3, 2; the
 * sound counts run 2, 1, 4; one bank is an emergency bank and two are not;
 * and no two counts within a bank are equal, so a summary that reported
 * `padCount` where it meant `audioCount` would be visible.
 */
async function seedThreeDistinctBanks(profileId: number): Promise<void> {
  const sounds: number[] = [];
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
    sounds.push(await addSound(name));
  }
  // Distinct bytes per sound, or deduplication by content hash collapses them
  // and the counts below stop meaning what they say.
  expect(new Set(sounds).size).toBe(sounds.length);
  const [a, b, shared, d, e, f, g] = sounds;

  await seedBank(profileId, OPENERS, [
    { padIndex: 0, name: "Horn", audioFileIds: [a, b] },
  ]);
  await seedBank(profileId, CLOSERS, [
    { padIndex: 0, name: "Rain", audioFileIds: [shared] },
    { padIndex: 1, name: "Wind", audioFileIds: [shared] },
    { padIndex: 2, name: "Sea", audioFileIds: [shared] },
  ]);
  await seedBank(profileId, WALKS, [
    { padIndex: 0, name: "Up", audioFileIds: [d, e] },
    { padIndex: 1, name: "Down", audioFileIds: [f, g] },
  ]);
}

describe("readArchiveManifest", () => {
  it("describes each bank in a bank archive", async () => {
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    await seedThreeDistinctBanks(profileId);

    // Neither the positional order nor the sorted one, so a reader that
    // walked the archive's entries instead of the manifest disagrees.
    const archive = await exportBanksToZip(
      profileId,
      ["9", OPENERS_ID, "0"],
      "blob",
    );

    const described = await readArchiveManifest(archive!);

    expect(described.kind).toBe("banks");
    if (described.kind !== "banks") throw new Error("unreachable");
    // An exact array rather than field-by-field matching: a summary that
    // grew a field, dropped one, or filled one from the wrong bank fails.
    expect(described.banks).toEqual([
      {
        folder: "0",
        name: "Walks",
        isEmergency: false,
        padCount: 2,
        audioCount: 4,
        sourceProfileName: "Show A",
        sourceBankId: "9",
      },
      {
        folder: "1",
        name: "Stings",
        isEmergency: true,
        padCount: 1,
        audioCount: 2,
        sourceProfileName: "Show A",
        sourceBankId: OPENERS_ID,
      },
      {
        folder: "2",
        name: "Beds",
        isEmergency: false,
        padCount: 3,
        audioCount: 1,
        sourceProfileName: "Show A",
        sourceBankId: "0",
      },
    ]);
  });

  it("says a profile archive is a profile archive", async () => {
    const { exportProfilesToZip } = await import("./importExport");
    const profileId = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    await seedBank(profileId, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);
    const archive = await exportProfilesToZip([profileId], "blob");

    expect(await readArchiveManifest(archive!)).toEqual({ kind: "profiles" });
  });

  it("says a legacy single-profile archive is a profile archive", async () => {
    const archive = await makeArchive({
      "profile.json": JSON.stringify({ exportVersion: 2, profile: {} }),
    });

    expect(await readArchiveManifest(archive)).toEqual({ kind: "profiles" });
  });

  it("routes a version 3 manifest to the profile importer without judging it", async () => {
    // Deliberately not re-checking that `profiles` is an array. The profile
    // importer says "Invalid or unsupported multi-profile ZIP format" for
    // that, and a second copy of the rule here would be free to drift from
    // the one that actually refuses the file.
    const archive = await makeArchive({
      "manifest.json": JSON.stringify({ exportVersion: 3 }),
    });

    expect(await readArchiveManifest(archive)).toEqual({ kind: "profiles" });
  });

  it("describes an empty manifest.json the way the profile importer treats it", async () => {
    // `importProfilesFromZip` tests the manifest text for truthiness, so an
    // empty entry falls through to `profile.json`. Answering anything else
    // here would describe a file differently from the code that imports it.
    const archive = await makeArchive({
      "manifest.json": "",
      "profile.json": JSON.stringify({ exportVersion: 2, profile: {} }),
    });

    expect(await readArchiveManifest(archive)).toEqual({ kind: "profiles" });
  });

  it("refuses an archive that is neither", async () => {
    const archive = await makeArchive({ "readme.txt": "hello" });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /missing manifest\.json or profile\.json/,
    );
  });

  it("refuses a file that is not a zip at all", async () => {
    // The first thing a picker can hand this function is a photo.
    await expect(
      readArchiveManifest(new Blob(["not a zip, just some bytes"])),
    ).rejects.toThrow();
  });

  it("names manifest.json when it is not valid JSON", async () => {
    const archive = await makeArchive({ "manifest.json": "{ not json" });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /manifest\.json .* not valid JSON/,
    );
  });

  it("refuses a bank entry that is not valid JSON", async () => {
    const archive = await oneBankArchive(LISTED_BANK, "{ not json");

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/0\/bank\.json .* not valid JSON/,
    );
  });

  it("refuses a manifest that is not an object", async () => {
    const archive = await makeArchive({ "manifest.json": '"a string"' });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /unsupported .iaz archive/i,
    );
  });

  it("refuses a manifest version this app does not know", async () => {
    const archive = await makeArchive({
      "manifest.json": JSON.stringify({
        exportVersion: 5,
        exportDate: EXPORT_DATE,
        banks: [],
      }),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /unsupported .iaz archive/i,
    );
  });

  it("refuses a manifest with no version at all", async () => {
    const archive = await makeArchive({
      "manifest.json": JSON.stringify({ banks: [] }),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /unsupported .iaz archive/i,
    );
  });

  it("refuses a version 4 manifest whose banks is not a list", async () => {
    const archive = await makeArchive({
      "manifest.json": JSON.stringify({
        exportVersion: 4,
        exportDate: EXPORT_DATE,
        banks: { "0": LISTED_BANK },
      }),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /unsupported .iaz archive/i,
    );
  });

  it("describes a bank archive holding no banks", async () => {
    const archive = await makeArchive({ "manifest.json": manifestJson([]) });

    expect(await readArchiveManifest(archive)).toEqual({
      kind: "banks",
      banks: [],
    });
  });

  it("refuses a folder that tries to climb out of the archive", async () => {
    // `folder` is a string out of the file. It is concatenated into an entry
    // path, and it is the key of the placement map the dialog builds, so it
    // has to be the decimal index this format defines and nothing else.
    const archive = await makeArchive({
      "manifest.json": manifestJson([{ ...LISTED_BANK, folder: "../../.." }]),
      "banks/0/bank.json": bankJson(),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /not a bank folder this format uses/,
    );
  });

  it("refuses a folder that is not a string", async () => {
    const archive = await makeArchive({
      "manifest.json": manifestJson([{ ...LISTED_BANK, folder: 0 }]),
      "banks/0/bank.json": bankJson(),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /not a bank folder this format uses/,
    );
  });

  it("refuses a manifest entry that is not an object", async () => {
    const archive = await makeArchive({
      "manifest.json": manifestJson(["banks/0"]),
      "banks/0/bank.json": bankJson(),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /not a bank folder this format uses/,
    );
  });

  it("truncates an absurd folder name rather than echoing it into an error", async () => {
    const archive = await makeArchive({
      "manifest.json": manifestJson([
        { ...LISTED_BANK, folder: "9".repeat(200000) },
      ]),
    });

    let message = "";
    try {
      await readArchiveManifest(archive);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/not a bank folder this format uses/);
    expect(message.length).toBeLessThan(200);
  });

  it("refuses a manifest naming one folder twice", async () => {
    // Two summaries with one folder key means the dialog's placement map
    // holds one of them and the import writes the other.
    const archive = await makeArchive({
      "manifest.json": manifestJson([
        LISTED_BANK,
        { ...LISTED_BANK, name: "Beds" },
      ]),
      "banks/0/bank.json": bankJson(),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /lists banks\/0 twice/,
    );
  });

  it("refuses a manifest promising a bank the archive does not hold", async () => {
    const archive = await makeArchive({
      "manifest.json": manifestJson([{ ...LISTED_BANK, folder: "1" }]),
      "banks/0/bank.json": bankJson(),
    });

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/1\/bank\.json/,
    );
  });

  it("names an empty bank entry rather than calling it missing", async () => {
    // An entry that is present and empty is a different fault from an entry
    // the archive does not hold, and the two have different fixes.
    const archive = await oneBankArchive(LISTED_BANK, "");

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/0\/bank\.json .* not valid JSON/,
    );
  });

  it("refuses a bank entry that is a list rather than a bank", async () => {
    const archive = await oneBankArchive(LISTED_BANK, "[]");

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/0\/bank\.json does not describe a bank/,
    );
  });

  it("refuses a bank entry with no page", async () => {
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ page: undefined }),
    );

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/0\/bank\.json does not describe a bank/,
    );
  });

  it("refuses a bank entry whose name is not a string", async () => {
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ page: { name: { evil: true }, isEmergency: false } }),
    );

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /banks\/0\/bank\.json does not describe a bank/,
    );
  });

  it("refuses a bank entry whose padConfigurations is not a list", async () => {
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ padConfigurations: "three" }),
    );

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /padConfigurations is not a list/,
    );
  });

  it("refuses a bank entry whose audioFiles is not a list", async () => {
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ audioFiles: 4 }),
    );

    await expect(readArchiveManifest(archive)).rejects.toThrow(
      /audioFiles is not a list/,
    );
  });

  it("takes the name and the flag from the bank, not from the manifest", async () => {
    // The manifest's copy is a convenience for a lister; `bank.json` is what
    // gets written into the profile, so it is what the dialog must show.
    const archive = await oneBankArchive(
      { name: "Lies", folder: "0", sourceProfileName: "Show A" },
      bankJson({ page: { name: "Stings", isEmergency: true } }),
    );

    const described = await readArchiveManifest(archive);
    if (described.kind !== "banks") throw new Error("unreachable");
    expect(described.banks[0].name).toBe("Stings");
    expect(described.banks[0].isEmergency).toBe(true);
  });

  it("reads the emergency flag as a flag, not as anything truthy", async () => {
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ page: { name: "Stings", isEmergency: "yes" } }),
    );

    const described = await readArchiveManifest(archive);
    if (described.kind !== "banks") throw new Error("unreachable");
    expect(described.banks[0].isEmergency).toBe(false);
  });

  it("takes the source profile name from the manifest, and only as a string", async () => {
    const archive = await makeArchive({
      "manifest.json": manifestJson([
        { name: "Stings", folder: "0", sourceProfileName: { evil: true } },
      ]),
      "banks/0/bank.json": bankJson(),
    });

    const described = await readArchiveManifest(archive);
    if (described.kind !== "banks") throw new Error("unreachable");
    expect(described.banks[0].sourceProfileName).toBe("");
  });

  it("carries sourceBankId verbatim, without cleaning it", async () => {
    // It is a *comparison* key: it is matched against the ids the destination
    // profile already holds so the dialog can offer "replace that bank", and
    // it is never adopted as an id. Cleaning it would make it look adoptable,
    // and a `#` in an adopted bank id breaks `baseKeyOf`'s playback keys.
    const hostile = "b1#9/../..";
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({ sourceBankId: hostile }),
    );

    const described = await readArchiveManifest(archive);
    if (described.kind !== "banks") throw new Error("unreachable");
    expect(described.banks[0].sourceBankId).toBe(hostile);
    // And it stays out of the one field that is used as a key.
    expect(described.banks[0].folder).toBe("0");
  });

  it("answers a matchless sourceBankId when the archive has none", async () => {
    // "" equals no bank id any profile holds, so the "replace that bank"
    // offer simply does not appear — which is the right answer for an
    // archive that does not say where it came from.
    for (const value of [undefined, 7, { evil: true }]) {
      const archive = await oneBankArchive(
        LISTED_BANK,
        bankJson({ sourceBankId: value }),
      );

      const described = await readArchiveManifest(archive);
      if (described.kind !== "banks") throw new Error("unreachable");
      expect(described.banks[0].sourceBankId).toBe("");
    }
  });

  it("describes a bank whose sounds have no bytes and whose pad names a sound it never declares", async () => {
    // Both of these come out of this app's own writer: `collectAudioForPads`
    // skips an audio row that has been deleted and leaves the pad's
    // reference alone, so a pad can name an id the bank never declares.
    const archive = await oneBankArchive(
      LISTED_BANK,
      bankJson({
        padConfigurations: [
          { padIndex: 0, name: "Horn", audioFileIds: [11, 12, 99] },
        ],
        audioFiles: [
          { id: 11, name: "a.wav", type: "audio/wav" },
          { id: 12, name: "b.wav", type: "audio/wav" },
        ],
      }),
    );

    const described = await readArchiveManifest(archive);
    if (described.kind !== "banks") throw new Error("unreachable");
    // Counts describe what the documents say, which is all a dialog can
    // honestly report before anything is extracted.
    expect(described.banks[0]).toMatchObject({ padCount: 1, audioCount: 2 });
  });
});

/**
 * Writing a bank into a profile — where an archive's data finally lands.
 *
 * Three rules from the tasks before this one are load-bearing here, and each
 * has its own tests below.
 *
 * `sourceBankId` is a *comparison* key. An "add" mints its own identity and a
 * "replace" carries one from the destination profile, so the archive's string
 * never becomes a bank id — which is what keeps a `#` in it out of a playback
 * key. The fixtures use an id containing one, so an implementation that
 * adopted it would be visible rather than merely possible.
 *
 * An archive carries no sync stamps, and a hand-edited one that carries some
 * anyway must not have them adopted: a foreign device's per-field stamps
 * either lose a local edit or manufacture a conflict modal. Every write here
 * mints local stamps.
 *
 * And audio is deduplicated by content hash, so writing a bank whose sounds
 * the destination already holds reuses those rows. `createdAudioIds` is the
 * rollback's only defence against deleting a row another profile depends on,
 * so it lists what was created and never what was reused.
 */
describe("writeBankIntoProfile", () => {
  /**
   * The destination's banks, at positions their ids do not encode.
   *
   * A UUID sits at position 0 and the perfectly ordinary id `"0"` sits at
   * position 2, so `banks[Number(bankId)]` — the conflation `bankId` exists
   * to end — answers "Held" when asked for "Kept" and would pass a fixture
   * where the two agree. The gap at position 1 is what makes "the first free
   * position" distinguishable from "one past the last" and from "the number
   * of banks".
   */
  const HELD_ID = "8c2d7f10-4a55-4b9e-8d31-6f0a9c3e7b21";
  const TARGET_BANKS = [
    { bankId: HELD_ID, pageIndex: 0, name: "Held" },
    { bankId: "0", pageIndex: 2, name: "Kept" },
  ] as const;

  /**
   * The archive's claim about where its bank came from.
   *
   * Deliberately a string no profile could hold and that would break
   * `baseKeyOf` if it ever reached a playback key: `baseKeyOf` splits at the
   * last `#` when the suffix is all digits, so a bank id of `"raid#7"` would
   * make every pad on it resolve to the base key `"raid"`.
   */
  const HOSTILE_SOURCE_BANK_ID = "raid#7";

  async function seedTargetProfile(): Promise<number> {
    const target = await addProfile({ name: "Show B", syncType: "local" });
    for (const bank of TARGET_BANKS) {
      await seedBank(target, bank, [
        { padIndex: 0, name: `${bank.name} pad`, audioFileIds: [] },
      ]);
    }
    return target;
  }

  /** One import source, carrying a real hash unless the caller withholds it. */
  async function sourceFor(
    originalId: number,
    name: string,
    options: { hash?: string | null; bytes?: string } = {},
  ) {
    const blob = new Blob([options.bytes ?? `the bytes of ${name}`], {
      type: "audio/wav",
    });
    const hash =
      options.hash === null
        ? undefined
        : (options.hash ?? (await computeBlobHash(blob)));
    return {
      originalId,
      name: `${name}.wav`,
      type: "audio/wav",
      hash,
      getBlob: vi.fn(async () => blob),
    };
  }

  /** A pad as it sits in a `bank.json`, with room for fields no type declares. */
  function incomingPad(fields: Record<string, unknown>) {
    return {
      padIndex: 0,
      name: "Horn",
      audioFileIds: [],
      playbackType: "sequential",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      ...fields,
    } as unknown as BankExportPad;
  }

  /** A bank as it sits in a `bank.json`. */
  function incomingBank(fields: Record<string, unknown> = {}): BankExport {
    return {
      exportVersion: 4,
      exportDate: "2020-01-01T00:00:00.000Z",
      sourceBankId: HOSTILE_SOURCE_BANK_ID,
      page: {
        name: "Stings",
        isEmergency: false,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      },
      padConfigurations: [],
      audioFiles: [],
      ...fields,
    } as unknown as BankExport;
  }

  async function padsOfBank(profileId: number, bankId: string) {
    const db = await getDb();
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    return pads
      .filter((pad) => pad.bankId === bankId)
      .sort((a, b) => a.padIndex - b.padIndex);
  }

  /**
   * Adds a bank holding one pad, and hands back the outcome and the pad row.
   *
   * The single most repeated shape in this describe block, and the jscpd gate
   * refused it as three copies before it was a function.
   */
  async function addOneBank(
    target: number,
    pad: Record<string, unknown>,
    audioSources: Awaited<ReturnType<typeof sourceFor>>[] = [],
  ) {
    const db = await getDb();
    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        padConfigurations: [incomingPad({ padIndex: 3, ...pad })],
      }),
      audioSources,
    });
    const [written] = await padsOfBank(target, result.bankId!);
    return { result, pad: written };
  }

  it("adds a bank at the first free position, under an id of its own", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();

    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        page: { name: "Stings", isEmergency: true },
        padConfigurations: [incomingPad({ padIndex: 3, name: "Horn" })],
      }),
      audioSources: [],
    });

    expect(result.written).toBe(true);
    // Position 1 is the gap. Two banks exist, and the last sits at 2, so
    // "one past the last" and "how many there are" both give other answers.
    expect(result.pageIndex).toBe(1);

    // The archive's claim is not an identity. Neither is any id already here.
    expect(result.bankId).not.toBe(HOSTILE_SOURCE_BANK_ID);
    expect(result.bankId).not.toBe(HELD_ID);
    expect(result.bankId).not.toBe("0");
    expect(result.bankId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const pages = await db.getAllFromIndex("pageMetadata", "profileId", target);
    expect(pages.map((page) => page.name).sort()).toEqual([
      "Held",
      "Kept",
      "Stings",
    ]);
    const written = pages.find((page) => page.name === "Stings");
    expect(written?.isEmergency).toBe(true);
    expect(written?.bankId).toBe(result.bankId);

    // The pad is filed under the minted id, not under the archive's string.
    expect(
      (await padsOfBank(target, result.bankId!)).map((p) => p.name),
    ).toEqual(["Horn"]);
  });

  it("keeps the destination's own bank id and position on replace", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();

    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "replace", bankId: "0" },
      bank: incomingBank({
        page: { name: "Stings", isEmergency: true },
        padConfigurations: [incomingPad({ padIndex: 3, name: "Horn" })],
      }),
      audioSources: [],
    });

    expect(result.bankId).toBe("0");
    // The bank whose id is "0" sits at position 2. Only an identity lookup
    // answers this; a position lookup lands on "Held".
    expect(result.pageIndex).toBe(2);

    const pages = await db.getAllFromIndex("pageMetadata", "profileId", target);
    expect(pages).toHaveLength(2);
    const replaced = pages.find((page) => page.bankId === "0");
    expect(replaced?.name).toBe("Stings");
    expect(replaced?.isEmergency).toBe(true);
    expect(replaced?.pageIndex).toBe(2);
    // The bank a position lookup would have taken is untouched.
    const held = pages.find((page) => page.bankId === HELD_ID);
    expect(held?.name).toBe("Held");
    expect(held?.pageIndex).toBe(0);
  });

  it("clears the pads the replaced bank had, and only that bank's", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    // A pad the incoming bank does not define: replace must clear it, or the
    // bank keeps sounds from the bank it replaced.
    await upsertPadConfiguration({
      profileId: target,
      bankId: "0",
      padIndex: 11,
      name: "Leftover",
      audioFileIds: [],
      playbackType: "sequential",
    });

    await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "replace", bankId: "0" },
      bank: incomingBank({
        padConfigurations: [incomingPad({ padIndex: 3, name: "Horn" })],
      }),
      audioSources: [],
    });

    expect((await padsOfBank(target, "0")).map((pad) => pad.name)).toEqual([
      "Horn",
    ]);
    // The other bank's pad is a bank away, not a profile away — a clear that
    // ranged the profile would take it too.
    expect((await padsOfBank(target, HELD_ID)).map((pad) => pad.name)).toEqual([
      "Held pad",
    ]);
  });

  it("refuses to replace a bank this profile does not hold", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    // Another profile's bank, with an id this profile does not have. Bank
    // identity is per profile, so holding it elsewhere is holding it nowhere.
    const other = await addProfile({ name: "Show C", syncType: "local" });
    await seedBank(other, {
      bankId: "elsewhere",
      pageIndex: 0,
      name: "Someone else's",
    });

    await expect(
      writeBankIntoProfile(db, {
        profileId: target,
        mode: { kind: "replace", bankId: "elsewhere" },
        bank: incomingBank(),
        audioSources: [],
      }),
      // Named exactly. `/elsewhere/` alone also matches
      // `upsertPageMetadata`'s "cannot create bank elsewhere without a
      // position", which is what a lookup that ranged every profile would
      // throw two steps later — so a loose assertion passes for the wrong
      // reason and cannot tell the guard from its absence.
    ).rejects.toThrow(/Bank elsewhere is no longer in this profile/);

    expect(
      await db.getAllFromIndex("pageMetadata", "profileId", target),
    ).toHaveLength(2);
    // And the bank it named, in the profile that really holds it, is untouched.
    const theirs = await db.getAllFromIndex("pageMetadata", "profileId", other);
    expect(theirs.map((page) => page.name)).toEqual(["Someone else's"]);
  });

  it("writes nothing at all on skip, not even the audio", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const source = await sourceFor(11, "sting");
    const before = (await db.getAll("audioFiles")).length;

    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "skip" },
      bank: incomingBank({
        padConfigurations: [incomingPad({ audioFileIds: [11] })],
      }),
      audioSources: [source],
    });

    expect(result).toEqual({ written: false, createdAudioIds: [] });
    expect(
      await db.getAllFromIndex("pageMetadata", "profileId", target),
    ).toHaveLength(2);
    // Importing the audio anyway would leave rows nothing references, and
    // the caller has no created-id list to roll them back with.
    expect(source.getBlob).not.toHaveBeenCalled();
    expect((await db.getAll("audioFiles")).length).toBe(before);
  });

  it("never adopts the archive's bank id, on either placement", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const bank = incomingBank({
      sourceBankId: HOSTILE_SOURCE_BANK_ID,
      padConfigurations: [incomingPad({ padIndex: 3 })],
    });

    const added = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank,
      audioSources: [],
    });
    const replaced = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "replace", bankId: HELD_ID },
      bank,
      audioSources: [],
    });

    expect(added.bankId).not.toBe(HOSTILE_SOURCE_BANK_ID);
    expect(replaced.bankId).toBe(HELD_ID);

    // Not as a bank id, and not on any row either: a pad filed under it would
    // reach `baseKeyOf` at trigger time.
    const pages = await db.getAllFromIndex("pageMetadata", "profileId", target);
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      target,
    );
    for (const row of [...pages, ...pads]) {
      expect(row.bankId).not.toBe(HOSTILE_SOURCE_BANK_ID);
    }
  });

  it("mints local sync stamps rather than adopting the archive's", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const before = Date.now();

    await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        page: {
          name: "Stings",
          isEmergency: false,
          _created: 1,
          _modified: 2,
          _fieldsModified: { name: 3 },
        },
        padConfigurations: [
          incomingPad({
            padIndex: 3,
            _created: 1,
            _modified: 2,
            _fieldsModified: { name: 3, audioFileIds: 4 },
          }),
        ],
      }),
      audioSources: [],
    });

    const page = (
      await db.getAllFromIndex("pageMetadata", "profileId", target)
    ).find((row) => row.name === "Stings");
    const [pad] = await padsOfBank(target, page!.bankId);

    // A foreign device's per-field stamps make every field the two profiles
    // disagree about a manual conflict, so they are minted, not carried.
    for (const row of [page!, pad]) {
      expect(row._created).toBeGreaterThanOrEqual(before);
      expect(row._modified).toBeGreaterThanOrEqual(before);
      expect(Object.keys(row._fieldsModified ?? {}).length).toBeGreaterThan(0);
      for (const at of Object.values(row._fieldsModified ?? {})) {
        expect(at).toBeGreaterThanOrEqual(before);
      }
    }
    // And the row's own dates are this device's, not the exporting device's.
    expect(pad.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(pad.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("drops every field that says where a row lived, and any it does not know", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    // A pad in another profile, whose id the archive claims for itself. A
    // write that carried `id` through would land on this row.
    const other = await addProfile({ name: "Show C", syncType: "local" });
    await seedBank(other, { bankId: "c0", pageIndex: 0, name: "Theirs" });
    const victimId = await upsertPadConfiguration({
      profileId: other,
      bankId: "c0",
      padIndex: 7,
      name: "Theirs",
      audioFileIds: [],
      playbackType: "sequential",
    });

    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        padConfigurations: [
          incomingPad({
            id: victimId,
            profileId: other,
            bankId: "c0",
            pageIndex: 9,
            padIndex: 3,
            name: "Horn",
            somethingNewer: "from a later version",
          }),
        ],
      }),
      audioSources: [],
    });

    const victim = await db.get("padConfigurations", victimId);
    expect(victim?.name).toBe("Theirs");
    expect(victim?.profileId).toBe(other);

    const [pad] = await padsOfBank(target, result.bankId!);
    expect(pad.name).toBe("Horn");
    expect(pad.profileId).toBe(target);
    expect(pad.bankId).toBe(result.bankId);
    expect(pad.id).not.toBe(victimId);
    expect(pad).not.toHaveProperty("pageIndex");
    expect(pad).not.toHaveProperty("somethingNewer");
  });

  it("re-keys the trim and gain onto the ids it wrote", async () => {
    const target = await seedTargetProfile();
    const sting = await sourceFor(11, "sting");

    const { pad } = await addOneBank(
      target,
      {
        keyBinding: "q",
        audioFileIds: [11],
        audioTrimSettings: { 11: { trimStart: 0.25, trimEnd: 1.75 } },
        audioGainSettings: { 11: -4.5 },
        padGainDb: 2,
        playbackType: "sequential",
        isDisabled: true,
        activePadBehavior: "layer",
      },
      [sting],
    );
    const newAudioId = pad.audioFileIds[0];
    // The archive's id is the exporting device's key. Leaving either map
    // keyed by it attaches the trim and the gain to the wrong sound.
    expect(newAudioId).not.toBe(11);
    expect(pad.audioGainSettings).toEqual({ [newAudioId]: -4.5 });
    expect(pad.audioTrimSettings).toEqual({
      [newAudioId]: { trimStart: 0.25, trimEnd: 1.75 },
    });
    expect(pad.padGainDb).toBe(2);
    expect(pad.playbackType).toBe("sequential");
    expect(pad.isDisabled).toBe(true);
    expect(pad.keyBinding).toBe("q");
    expect(pad.activePadBehavior).toBe("layer");
  });

  it("lists a sound it really created, so the rollback can take it back", async () => {
    const target = await seedTargetProfile();
    const sting = await sourceFor(11, "sting");

    const { result, pad } = await addOneBank(target, { audioFileIds: [11] }, [
      sting,
    ]);
    expect(result.createdAudioIds).toEqual([pad.audioFileIds[0]]);
  });

  it("reuses a sound the library already holds, and does not list it as created", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    // Seeded under another profile on purpose: deleting this row on rollback
    // is the data loss `createdAudioIds` exists to prevent.
    const existing = await addSound("sting");
    const before = (await db.getAll("audioFiles")).length;
    const sting = await sourceFor(11, "sting");

    const { result, pad } = await addOneBank(target, { audioFileIds: [11] }, [
      sting,
    ]);
    expect(pad.audioFileIds).toEqual([existing]);
    expect(result.createdAudioIds).toEqual([]);
    expect((await db.getAll("audioFiles")).length).toBe(before);
    // The hash came with the reference, so the bytes were never asked for.
    expect(sting.getBlob).not.toHaveBeenCalled();
  });

  it("reuses by bytes when the archive states no hash", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const existing = await addSound("sting");
    const before = (await db.getAll("audioFiles")).length;
    // No hash, so the reuse cannot happen before the read: this is the
    // second reuse branch, the one inside the write transaction, and it has
    // its own fixture because a shared one only ever exercises the first.
    const sting = await sourceFor(11, "sting", { hash: null });

    const { result, pad } = await addOneBank(target, { audioFileIds: [11] }, [
      sting,
    ]);
    expect(sting.getBlob).toHaveBeenCalled();
    expect(pad.audioFileIds).toEqual([existing]);
    expect(result.createdAudioIds).toEqual([]);
    expect((await db.getAll("audioFiles")).length).toBe(before);
  });

  it("drops a reference to a sound the archive never supplies", async () => {
    const target = await seedTargetProfile();
    // Both of these come out of this app's own writer: a pad may name an id
    // `audioFiles` never declares, and a declared id may have no bytes — so
    // neither is corruption and neither may fail the bank.
    const sting = await sourceFor(11, "sting");

    const { pad } = await addOneBank(
      target,
      {
        name: "Horn",
        audioFileIds: [11, 12],
        audioTrimSettings: {
          11: { trimStart: 0, trimEnd: 1 },
          12: { trimStart: 2, trimEnd: 3 },
        },
        audioGainSettings: { 11: -4.5, 12: -6 },
      },
      [sting],
    );
    const kept = pad.audioFileIds[0];
    expect(pad.audioFileIds).toHaveLength(1);
    expect(pad.name).toBe("Horn");
    // A setting left keyed by 12 would attach to whatever sound is written
    // under id 12 next.
    expect(pad.audioTrimSettings).toEqual({
      [kept]: { trimStart: 0, trimEnd: 1 },
    });
    expect(pad.audioGainSettings).toEqual({ [kept]: -4.5 });
  });

  it("carries a pre-V3 pad's single audioFileId", async () => {
    const target = await seedTargetProfile();
    const sting = await sourceFor(11, "sting");

    // The export is subtractive, so a pad row still carrying the pre-V3
    // scalar carries it into the archive — and `collectAudioForPads` reads
    // that spelling too, so the bytes are there to attach.
    const { result, pad } = await addOneBank(
      target,
      { audioFileIds: undefined, audioFileId: 11 },
      [sting],
    );
    expect(pad.audioFileIds).toHaveLength(1);
    expect(pad.audioFileIds[0]).toBe(result.createdAudioIds[0]);
  });

  it("fails, naming what it created, when a sound cannot be materialised", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const good = await sourceFor(11, "sting");
    const bad = await sourceFor(12, "bed");
    bad.getBlob = vi.fn(async () => {
      throw new Error("that entry is not in the archive");
    });

    const error = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        padConfigurations: [
          incomingPad({ padIndex: 3, audioFileIds: [11, 12] }),
        ],
      }),
      audioSources: [good, bad],
    }).then(
      () => null,
      (thrown) => thrown as Error & { createdAudioIds?: number[] },
    );

    expect(error?.message).toMatch(/bed\.wav/);
    // Nothing was placed, so the bank does not arrive silently one sound short.
    expect(
      await db.getAllFromIndex("pageMetadata", "profileId", target),
    ).toHaveLength(2);
    // The row written before the failure would otherwise be an orphan the
    // caller never hears about.
    expect(error?.createdAudioIds).toHaveLength(1);
    expect(
      await db.get("audioFiles", error!.createdAudioIds![0]),
    ).toBeDefined();
  });

  it("refuses a pad whose position is not a pad position, before writing anything", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();
    const before = (await db.getAll("audioFiles")).length;

    for (const padIndex of [-1, TOTAL_PADS, 1.5, "3", undefined, NaN]) {
      const sting = await sourceFor(11, "sting");
      await expect(
        writeBankIntoProfile(db, {
          profileId: target,
          mode: { kind: "add" },
          bank: incomingBank({
            padConfigurations: [incomingPad({ padIndex, audioFileIds: [11] })],
          }),
          audioSources: [sting],
        }),
        // `padIndex` is a component of the `profileBankPad` key, so a bad one
        // is a DataError partway through a write rather than an odd pad.
      ).rejects.toThrow(/pad/i);
      expect(sting.getBlob).not.toHaveBeenCalled();
    }

    expect(
      await db.getAllFromIndex("pageMetadata", "profileId", target),
    ).toHaveLength(2);
    expect((await db.getAll("audioFiles")).length).toBe(before);
  });

  it("reads a hand-edited flag as a flag, not as anything truthy", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();

    const result = await writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        page: { name: "Stings", isEmergency: "yes" },
        padConfigurations: [
          incomingPad({ padIndex: 3, isDisabled: "yes", padGainDb: "loud" }),
        ],
      }),
      audioSources: [],
    });

    const page = (
      await db.getAllFromIndex("pageMetadata", "profileId", target)
    ).find((row) => row.bankId === result.bankId);
    // An emergency bank answers the emergency key; `"yes"` must not make one.
    expect(page?.isEmergency).toBe(false);

    const [pad] = await padsOfBank(target, result.bankId!);
    expect(pad.isDisabled).toBe(false);
    // A non-numeric gain reaches the gain node as NaN and throws at trigger.
    expect(pad.padGainDb).toBeUndefined();
  });

  it("holds off the orphan sweep until its pads name the audio it wrote", async () => {
    const db = await getDb();
    const target = await seedTargetProfile();

    // The window this guards is *between* the two audio writes, not before
    // them: the first sound has to be in the library and unreferenced before
    // the sweep has anything to take. So the second sound's bytes are held,
    // and the sweep starts the moment they are asked for.
    const sting = await sourceFor(11, "sting");
    const bed = await sourceFor(12, "bed", { hash: null });
    let release: (() => void) | undefined;
    let asked: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const askedFor = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const bedBytes = new Blob(["the bytes of bed"], { type: "audio/wav" });
    bed.getBlob = vi.fn(async () => {
      asked!();
      await gate;
      return bedBytes;
    });

    const writing = writeBankIntoProfile(db, {
      profileId: target,
      mode: { kind: "add" },
      bank: incomingBank({
        padConfigurations: [
          incomingPad({ padIndex: 3, audioFileIds: [11, 12] }),
        ],
      }),
      audioSources: [sting, bed],
    });

    await askedFor;
    // The fixture can only exhibit the failure if the orphan is really there.
    expect(await db.getAll("audioFiles")).toHaveLength(1);

    const sweeping = cleanupOrphanedAudioFiles();
    release!();
    const result = await writing;
    const swept = await sweeping;

    expect(swept.deletedCount).toBe(0);
    const [pad] = await padsOfBank(target, result.bankId!);
    expect(pad.audioFileIds).toHaveLength(2);
    for (const audioFileId of pad.audioFileIds) {
      expect(await db.get("audioFiles", audioFileId)).toBeDefined();
    }
  });
});

/**
 * Writing an archive's banks into one profile.
 *
 * This is the orchestrator, so the fixtures are deliberately bigger than the
 * ones below it. Four banks rather than two, because a single-bank fixture
 * cannot tell "wrote the banks the map named" from "wrote the first one", and
 * cannot put a failure in the *middle* of a set at all — which is the only
 * place the rollback is interesting.
 *
 * Two facts about the fixtures are load-bearing:
 *
 * - The source profile is **deleted** before the archive is imported
 *   (`archiveFromElsewhere`). While its rows are still in the library every
 *   sound in the archive is *reused* by content hash rather than created, so
 *   a rollback that deleted reused rows would look perfectly correct and the
 *   created/reused split would never be exercised. The one test that means to
 *   check reuse keeps the source on purpose.
 * - Every "refuses before any write" test seeds a destination that already
 *   holds banks, pads and audio, and asserts they are still there. A rollback
 *   is "delete every bank this profile did not have before", so a rollback
 *   that ran with no baseline would empty the profile — and a fixture whose
 *   destination is empty could not tell that apart from doing nothing.
 */
describe("importBanksFromZip", () => {
  /**
   * A fourth bank, so a failure can land with banks written on both sides of
   * it. `"7"` at position 3 keeps the id/position disagreement the other
   * three fixtures rely on.
   */
  const HORNS = {
    bankId: "7",
    pageIndex: 3,
    name: "Horns",
    isEmergency: false,
  } as const;

  /**
   * Which archive folder holds which bank.
   *
   * The export order below is neither the banks' position order nor their id
   * order, so a placement map keyed by folder cannot accidentally agree with
   * either.
   */
  const FOLDER = { walks: "0", stings: "1", beds: "2", horns: "3" } as const;

  /** The destination's first bank, at a position its id does not encode. */
  const HELD_BANK_ID = "d41f6b3c-9a72-4e15-8b0d-5c7e2f8a1934";

  /** A show worth four banks, one sound of which two banks share. */
  async function showAArchive(): Promise<{ source: number; archive: Blob }> {
    const source = await addProfile({ name: "Show A", syncType: "local" });
    const sting = await addSound("sting");
    const bed = await addSound("bed");
    const walk = await addSound("walk");
    const horn = await addSound("horn");
    expect(new Set([sting, bed, walk, horn]).size).toBe(4);

    await seedBank(source, OPENERS, [
      { padIndex: 0, name: "Horn", audioFileIds: [sting] },
    ]);
    await seedBank(source, CLOSERS, [
      { padIndex: 5, name: "Rain", audioFileIds: [bed] },
      { padIndex: 6, name: "Both", audioFileIds: [bed, sting] },
    ]);
    await seedBank(source, WALKS, [
      { padIndex: 2, name: "Walk", audioFileIds: [walk] },
    ]);
    await seedBank(source, HORNS, [
      { padIndex: 1, name: "Blast", audioFileIds: [horn] },
    ]);

    const archive = await exportBanksToZip(
      source,
      [WALKS.bankId, OPENERS.bankId, CLOSERS.bankId, HORNS.bankId],
      "blob",
    );
    return { source, archive: archive! };
  }

  /** The same archive, as it arrives on a device that never had Show A. */
  async function archiveFromElsewhere(): Promise<Blob> {
    const { source, archive } = await showAArchive();
    await deleteProfile(source);
    expect(await (await getDb()).getAll("audioFiles")).toHaveLength(0);
    return archive;
  }

  /**
   * The destination: two banks holding one sound between them, at positions
   * 0 and 2.
   *
   * The gap at 1 is what tells "the first free position" from "one past the
   * last" and from "the number of banks". `"0"` as the second bank's id is
   * the id the archive's own "Beds" bank carries, so a write that adopted the
   * archive's identity would land on top of it.
   */
  async function seedShowB(): Promise<{ target: number; held: number }> {
    const target = await addProfile({ name: "Show B", syncType: "local" });
    const held = await addSound("held");
    await seedBank(
      target,
      { bankId: HELD_BANK_ID, pageIndex: 0, name: "Held" },
      [{ padIndex: 0, name: "Held pad", audioFileIds: [held] }],
    );
    await seedBank(target, { bankId: "0", pageIndex: 2, name: "Kept" }, [
      { padIndex: 4, name: "Kept pad", audioFileIds: [held] },
    ]);
    return { target, held };
  }

  async function banksOf(profileId: number) {
    const db = await getDb();
    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      profileId,
    );
    return pages.sort((a, b) => a.pageIndex - b.pageIndex);
  }

  async function padRowsOf(profileId: number) {
    const db = await getDb();
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    return pads.sort((a, b) =>
      a.bankId === b.bankId
        ? a.padIndex - b.padIndex
        : a.bankId.localeCompare(b.bankId),
    );
  }

  async function padsOfBank(profileId: number, bankId: string) {
    return (await padRowsOf(profileId)).filter((pad) => pad.bankId === bankId);
  }

  async function audioIds(): Promise<number[]> {
    const db = await getDb();
    return (await db.getAll("audioFiles"))
      .map((file) => file.id!)
      .sort((a, b) => a - b);
  }

  async function bytesOf(id: number): Promise<string> {
    const db = await getDb();
    const row = await db.get("audioFiles", id);
    return row!.blob.text();
  }

  /** Adds all four banks — the setup several tests start from. */
  async function addAllFour(
    archive: Blob,
    target: number,
    onProgress?: (progress: TransferProgress) => void,
  ) {
    return importBanksFromZip(
      archive,
      await getDb(),
      {
        profileId: target,
        placements: {
          [FOLDER.walks]: { kind: "add" },
          [FOLDER.stings]: { kind: "add" },
          [FOLDER.beds]: { kind: "add" },
          [FOLDER.horns]: { kind: "add" },
        },
      },
      onProgress,
    );
  }

  /**
   * A hand-built one-bank archive: one pad, and whatever `audioFiles` says.
   *
   * The sound entries an exporter would write are not enough here — the cases
   * that matter are a reference with no bytes behind it, a reference that is
   * not a reference, and a hash that is not a string.
   */
  function oddBankArchive(
    audioFiles: unknown[],
    audioFileIds: unknown[],
  ): Promise<Blob> {
    return makeArchive({
      "manifest.json": manifestJson([
        { name: "Odd", folder: "0", sourceProfileName: "Show A" },
      ]),
      "banks/0/bank.json": bankJson({
        page: { name: "Odd", isEmergency: false },
        padConfigurations: [
          {
            padIndex: 2,
            name: "Odd pad",
            audioFileIds,
            playbackType: "sequential",
          },
        ],
        audioFiles,
      }),
      "audio/1": "the bytes of here",
    });
  }

  /** Fills a profile up to `total` banks, at positions nothing else uses. */
  async function fillTo(profileId: number, total: number): Promise<void> {
    const have = (await banksOf(profileId)).length;
    for (let index = 0; index < total - have; index++) {
      await upsertPageMetadata({
        profileId,
        bankId: `filler-${index}`,
        pageIndex: 10 + index,
        name: `Filler ${index}`,
        isEmergency: false,
      });
    }
    expect(await banksOf(profileId)).toHaveLength(total);
  }

  /**
   * Flips a byte inside one entry's stored data.
   *
   * A truncated download or a bad sector, in other words: zip.js checks what
   * it inflates, so `getData` throws rather than handing back different
   * bytes. It is the only way to build the case the module comment calls "an
   * archive that promised bytes and could not deliver them" — a *missing*
   * entry is a different thing, and is dropped rather than fatal.
   */
  async function corruptEntry(archive: Blob, name: string): Promise<Blob> {
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const wanted = new TextEncoder().encode(name);
    let at = -1;
    search: for (let i = 0; i + wanted.length <= bytes.length; i++) {
      for (let j = 0; j < wanted.length; j++) {
        if (bytes[i + j] !== wanted[j]) continue search;
      }
      at = i;
      break;
    }
    expect(at).toBeGreaterThan(0);
    // The local file header ends with the name length and the extra-field
    // length, immediately before the name itself; the data follows both.
    const nameLength = bytes[at - 4] | (bytes[at - 3] << 8);
    const extraLength = bytes[at - 2] | (bytes[at - 1] << 8);
    const dataAt = at + nameLength + extraLength;
    bytes[dataAt] ^= 0xff;
    return new Blob([bytes], { type: "application/zip" });
  }

  it("writes every bank the placement map names, in the archive's order", async () => {
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();

    const result = await addAllFour(archive, target);

    expect(
      result.written.map((bank) => [bank.folder, bank.name, bank.pageIndex]),
    ).toEqual([
      ["0", "Walks", 1],
      ["1", "Stings", 3],
      ["2", "Beds", 4],
      ["3", "Horns", 5],
    ]);
    expect(result.skipped).toEqual([]);

    // Four fresh identities, none of them the archive's — and "0" would have
    // collided with the destination's own second bank.
    const ids = result.written.map((bank) => bank.bankId);
    expect(new Set(ids).size).toBe(4);
    for (const sourceId of [
      WALKS.bankId,
      OPENERS.bankId,
      CLOSERS.bankId,
      HORNS.bankId,
    ]) {
      expect(ids).not.toContain(sourceId);
    }

    expect((await banksOf(target)).map((bank) => bank.name)).toEqual([
      "Held",
      "Walks",
      "Kept",
      "Stings",
      "Beds",
      "Horns",
    ]);
  });

  it("brings each bank's pads and the bytes of their sounds", async () => {
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();

    const result = await addAllFour(archive, target);
    const byName = new Map(
      result.written.map((bank) => [bank.name, bank.bankId]),
    );

    const beds = await padsOfBank(target, byName.get("Beds")!);
    expect(beds.map((pad) => [pad.padIndex, pad.name])).toEqual([
      [5, "Rain"],
      [6, "Both"],
    ]);
    expect(await bytesOf(beds[0].audioFileIds[0])).toBe("the bytes of bed");
    expect(beds[1].audioFileIds).toHaveLength(2);
    expect(await bytesOf(beds[1].audioFileIds[0])).toBe("the bytes of bed");
    expect(await bytesOf(beds[1].audioFileIds[1])).toBe("the bytes of sting");

    // One row for a sound two banks name: the sting the Stings bank plays is
    // the very row the Beds bank's second slot names.
    const stings = await padsOfBank(target, byName.get("Stings")!);
    expect(stings.map((pad) => pad.audioFileIds)).toEqual([
      [beds[1].audioFileIds[1]],
    ]);

    // Five sounds in the library: the destination's own, plus the archive's
    // four, with the shared sting stored once.
    expect(await audioIds()).toHaveLength(5);
  });

  it("skips a bank the map skips, and one it does not name at all", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();

    const result = await importBanksFromZip(archive, db, {
      profileId: target,
      placements: {
        [FOLDER.walks]: { kind: "add" },
        [FOLDER.stings]: { kind: "skip" },
        [FOLDER.horns]: { kind: "add" },
      },
    });

    expect(result.written.map((bank) => bank.name)).toEqual(["Walks", "Horns"]);
    expect(result.skipped).toEqual(["Stings", "Beds"]);
    expect((await banksOf(target)).map((bank) => bank.name)).toEqual([
      "Held",
      "Walks",
      "Kept",
      "Horns",
    ]);
    // Nothing of a skipped bank reaches the library, not even its audio.
    expect(await audioIds()).toHaveLength(3);
  });

  it("adds no audio row when a bank goes back into the profile it came from", async () => {
    const db = await getDb();
    const { source, archive } = await showAArchive();
    const before = await audioIds();

    const result = await importBanksFromZip(archive, db, {
      profileId: source,
      placements: { [FOLDER.beds]: { kind: "add" } },
    });

    expect(result.written).toHaveLength(1);
    expect(await audioIds()).toEqual(before);
    const copy = await padsOfBank(source, result.written[0].bankId);
    const original = await padsOfBank(source, CLOSERS.bankId);
    expect(copy.map((pad) => pad.audioFileIds)).toEqual(
      original.map((pad) => pad.audioFileIds),
    );
  });

  it("refuses the whole set before any write when the free slots run out", async () => {
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();
    await fillTo(target, MAX_BANKS - 3);
    const banksBefore = await banksOf(target);
    const padsBefore = await padRowsOf(target);
    const audioBefore = await audioIds();

    await expect(addAllFour(archive, target)).rejects.toThrow(/free slot/i);

    expect(await banksOf(target)).toEqual(banksBefore);
    expect(await padRowsOf(target)).toEqual(padsBefore);
    expect(await audioIds()).toEqual(audioBefore);
  });

  it("counts only the banks it adds against the free slots", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();
    await fillTo(target, MAX_BANKS);

    const result = await importBanksFromZip(archive, db, {
      profileId: target,
      placements: {
        [FOLDER.walks]: { kind: "replace", bankId: HELD_BANK_ID },
      },
    });

    expect(
      result.written.map((bank) => [bank.name, bank.bankId, bank.pageIndex]),
    ).toEqual([["Walks", HELD_BANK_ID, 0]]);
    expect(await banksOf(target)).toHaveLength(MAX_BANKS);
  });

  it("refuses an archive of profiles, without touching the destination", async () => {
    const db = await getDb();
    const { target } = await seedShowB();
    const archive = await makeArchive({
      "profile.json": JSON.stringify({ exportVersion: 2 }),
    });
    const banksBefore = await banksOf(target);

    await expect(
      importBanksFromZip(archive, db, { profileId: target, placements: {} }),
    ).rejects.toThrow(/profiles, not banks/i);

    expect(await banksOf(target)).toEqual(banksBefore);
    expect(await padRowsOf(target)).toHaveLength(2);
    expect(await audioIds()).toHaveLength(1);
  });

  it("refuses a file that is neither, without touching the destination", async () => {
    const db = await getDb();
    const { target } = await seedShowB();
    const archive = await makeArchive({ "readme.txt": "hello" });
    const banksBefore = await banksOf(target);

    await expect(
      importBanksFromZip(archive, db, { profileId: target, placements: {} }),
    ).rejects.toThrow(/missing manifest\.json or profile\.json/);

    expect(await banksOf(target)).toEqual(banksBefore);
    expect(await padRowsOf(target)).toHaveLength(2);
    expect(await audioIds()).toHaveLength(1);
  });

  it("puts every bank back the way it was when a later bank fails", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();
    const banksBefore = await banksOf(target);
    const padsBefore = await padRowsOf(target);
    const audioBefore = await audioIds();

    await expect(
      importBanksFromZip(archive, db, {
        profileId: target,
        placements: {
          [FOLDER.walks]: { kind: "replace", bankId: HELD_BANK_ID },
          [FOLDER.stings]: { kind: "add" },
          [FOLDER.beds]: { kind: "replace", bankId: "not-here" },
          [FOLDER.horns]: { kind: "add" },
        },
      }),
    ).rejects.toThrow(/no longer in this profile/);

    // Row for row, id for id: the replaced bank's own pads are back, the two
    // banks that were added are gone, and so is the audio they created.
    expect(await banksOf(target)).toEqual(banksBefore);
    expect(await padRowsOf(target)).toEqual(padsBefore);
    expect(await audioIds()).toEqual(audioBefore);
  });

  it("keeps a sound it reused, and an orphan it never touched, when it takes back what it created", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target, held } = await seedShowB();
    // Two rows no pad names. The first holds the very bytes the archive's
    // "Walks" bank carries, so that bank reuses it rather than creating one;
    // the second has nothing to do with this import at all. A rollback that
    // deleted what it reused would take the first, and one that reached for
    // the orphan sweep instead of the list of what it created would take
    // both.
    const reused = await addSound("walk");
    const stranger = await addSound("stranger");
    expect(new Set([held, reused, stranger]).size).toBe(3);

    await expect(
      importBanksFromZip(archive, db, {
        profileId: target,
        placements: {
          [FOLDER.walks]: { kind: "add" },
          [FOLDER.stings]: { kind: "add" },
          [FOLDER.beds]: { kind: "replace", bankId: "not-here" },
        },
      }),
    ).rejects.toThrow(/no longer in this profile/);

    expect(await audioIds()).toEqual(
      [held, reused, stranger].sort((a, b) => a - b),
    );
  });

  it("takes back the audio a failing bank had already written", async () => {
    const db = await getDb();
    const { target } = await seedShowB();
    const audioBefore = await audioIds();
    const banksBefore = await banksOf(target);

    const archive = await corruptEntry(
      await makeArchive({
        "manifest.json": manifestJson([
          { name: "First", folder: "0", sourceProfileName: "Show A" },
          { name: "Second", folder: "1", sourceProfileName: "Show A" },
        ]),
        "banks/0/bank.json": bankJson({
          page: { name: "First", isEmergency: false },
          padConfigurations: [
            {
              padIndex: 0,
              name: "One",
              audioFileIds: [1],
              playbackType: "sequential",
            },
          ],
          audioFiles: [{ id: 1, name: "one.wav", type: "audio/wav" }],
        }),
        "banks/1/bank.json": bankJson({
          page: { name: "Second", isEmergency: false },
          padConfigurations: [
            {
              padIndex: 0,
              name: "Two",
              audioFileIds: [2, 3],
              playbackType: "sequential",
            },
          ],
          audioFiles: [
            { id: 2, name: "two.wav", type: "audio/wav" },
            { id: 3, name: "three.wav", type: "audio/wav" },
          ],
        }),
        "audio/1": "the bytes of one",
        "audio/2": "the bytes of two",
        "audio/3": "the bytes of three, and enough of them to deflate ".repeat(
          8,
        ),
      }),
      "audio/3",
    );

    await expect(
      importBanksFromZip(archive, db, {
        profileId: target,
        placements: { "0": { kind: "add" }, "1": { kind: "add" } },
      }),
    ).rejects.toThrow(/could not be imported/);

    // Sound 2 was written before sound 3 was reached, and the write that
    // wrote it never returned — so the only route back to it is the error.
    expect(await audioIds()).toEqual(audioBefore);
    expect(await banksOf(target)).toEqual(banksBefore);
  });

  it("refuses two placements that replace the same bank, before any write", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();
    const banksBefore = await banksOf(target);
    const audioBefore = await audioIds();

    await expect(
      importBanksFromZip(archive, db, {
        profileId: target,
        placements: {
          [FOLDER.walks]: { kind: "replace", bankId: HELD_BANK_ID },
          [FOLDER.stings]: { kind: "replace", bankId: HELD_BANK_ID },
        },
      }),
    ).rejects.toThrow(/same bank/i);

    expect(await banksOf(target)).toEqual(banksBefore);
    expect(await audioIds()).toEqual(audioBefore);
  });

  it("writes a bank whose sounds have no bytes, or are not references at all", async () => {
    const db = await getDb();
    const { target } = await seedShowB();
    // The pad names three sounds: one with bytes, one declared with no
    // `audio/` entry behind it, and one the bank never declares. Only the
    // first can be written, and the other two are dropped rather than failing
    // the bank — both come out of this app's own writer.
    const archive = await oddBankArchive(
      [
        { id: 1, name: "here.wav", type: "audio/wav" },
        { id: 2, name: "gone.wav", type: "audio/wav" },
        null,
      ],
      [1, 2, 3],
    );

    const result = await importBanksFromZip(archive, db, {
      profileId: target,
      placements: { "0": { kind: "add" } },
    });

    const pads = await padsOfBank(target, result.written[0].bankId);
    expect(pads.map((pad) => pad.padIndex)).toEqual([2]);
    expect(pads[0].audioFileIds).toHaveLength(1);
    expect(await bytesOf(pads[0].audioFileIds[0])).toBe("the bytes of here");
  });

  it("ignores a stated hash that is not a hash, rather than failing the bank", async () => {
    const db = await getDb();
    const { target } = await seedShowB();
    // A hash is an IndexedDB key on the way in, and an invalid one is not
    // refused here: `index.getAll({…})` answers with every row in the
    // library, so without the guard this pad ends up naming the destination
    // profile's own sound instead of the one the archive carried.
    const archive = await oddBankArchive(
      [{ id: 1, name: "here.wav", type: "audio/wav", hash: { not: "one" } }],
      [1],
    );

    const result = await importBanksFromZip(archive, db, {
      profileId: target,
      placements: { "0": { kind: "add" } },
    });

    const pads = await padsOfBank(target, result.written[0].bankId);
    expect(await bytesOf(pads[0].audioFileIds[0])).toBe("the bytes of here");
  });

  it("holds each bank's audio to its pads, so a sweep between banks takes nothing", async () => {
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();

    // The orphan sweep, fired once per bank as the import runs. It waits for
    // whatever write is in flight and then looks — so if the audio of the
    // banks already written were not yet named by their pads, it would delete
    // exactly that, and say so in its count.
    const sweeps: Promise<{ deletedCount: number }>[] = [];
    const result = await addAllFour(archive, target, (progress) => {
      if (progress.phase === "audio") sweeps.push(cleanupOrphanedAudioFiles());
    });

    expect(result.written).toHaveLength(4);
    expect(
      (await Promise.all(sweeps)).map((sweep) => sweep.deletedCount),
    ).toEqual([0, 0, 0, 0]);
    for (const pad of await padRowsOf(target)) {
      for (const id of pad.audioFileIds) {
        expect(await bytesOf(id)).toContain("the bytes of");
      }
    }
  });

  it("reports one step per bank it writes, and a finish", async () => {
    const db = await getDb();
    const archive = await archiveFromElsewhere();
    const { target } = await seedShowB();
    const seen: TransferProgress[] = [];

    await importBanksFromZip(
      archive,
      db,
      {
        profileId: target,
        placements: {
          [FOLDER.walks]: { kind: "add" },
          [FOLDER.stings]: { kind: "skip" },
          [FOLDER.beds]: { kind: "add" },
        },
      },
      (progress) => seen.push(progress),
    );

    expect(seen[0].phase).toBe("preparing");
    expect(
      seen
        .filter((step) => step.phase === "audio")
        .map((step) => [step.fileName, step.processedFiles, step.totalFiles]),
    ).toEqual([
      ["Walks", 0, 2],
      ["Beds", 1, 2],
    ]);
    expect(seen.at(-1)).toMatchObject({
      phase: "finalizing",
      processedFiles: 2,
      totalFiles: 2,
    });
  });
});
