/**
 * The `.iaz` round trip — export to a ZIP, import it back.
 *
 * This path and `importImpamp2Profile` are about 31% of `importExport.ts` and
 * had no test of any kind, while being reachable from the UI and being the
 * thing a user reaches for when they are moving a board between machines or
 * restoring one. It is also the path that writes audio records without a hash
 * and parses three JSON documents out of an untrusted archive with no
 * validation, so it is the last part of this file that should be refactored
 * uncovered.
 *
 * A round trip is the right shape of test here: the two halves have to agree
 * about a format that is defined in one place and read in another, which is
 * precisely where this codebase goes wrong.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeArchive } from "@/lib/testSupport/zipArchive";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. Its rejection is logged after this file has
// finished, and that log is what tears the worker down mid-run under
// coverage. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

const { exportProfilesToZip, importProfilesFromZip } =
  await import("./importExport");
const {
  getDb,
  addProfile,
  addAudioFile,
  upsertPadConfiguration,
  upsertPageMetadata,
} = await import("./db");

async function seedProfile(name: string, soundName: string) {
  const profileId = await addProfile({
    name,
    syncType: "local",
    activePadBehavior: "restart",
    backupReminderPeriod: 4321,
  });

  const audioFileId = await addAudioFile({
    name: `${soundName}.wav`,
    type: "audio/wav",
    blob: new Blob([`bytes for ${soundName}`], { type: "audio/wav" }),
  });

  await upsertPadConfiguration({
    profileId,
    bankId: "0",
    padIndex: 3,
    keyBinding: "q",
    name: soundName,
    audioFileIds: [audioFileId],
    playbackType: "sequential",
    audioGainSettings: { [audioFileId]: -4.5 },
    padGainDb: 2,
  });

  await upsertPageMetadata({
    profileId,
    bankId: "0",
    pageIndex: 0,
    name: "Opening",
    isEmergency: true,
  });

  return { profileId, audioFileId };
}

beforeEach(async () => {
  await clearAllStores();
});

/**
 * Exports one profile, imports the archive back, and returns the copy — which
 * is every test's first three steps.
 */
async function roundTrip(profileId: number) {
  const db = await getDb();
  const archive = await exportProfilesToZip([profileId], "blob");
  const results = await importProfilesFromZip(archive!, db);

  const imported = (await db.getAll("profiles")).find(
    (p) => p.id !== profileId,
  )!;
  const pads = await db.getAllFromIndex(
    "padConfigurations",
    "profileId",
    imported.id!,
  );

  return { db, archive, results, imported, pads };
}

/**
 * Builds a `profile.json`-shaped archive whose banks and pads carry
 * `pageIndex` and no `bankId` at all — genuinely what an archive written
 * before bank identity existed looks like, not a modern record that happens
 * to already have one — and imports it. A fixture that already carried
 * `bankId` could not tell whether the migration fallback ran or was dropped.
 */
async function roundTripLegacyProfile(data: {
  pageMetadata: Array<{
    pageIndex: number;
    name: string;
    isEmergency: boolean;
  }>;
  padConfigurations: Array<{
    pageIndex: number;
    padIndex: number;
    audioFileIds: number[];
    playbackType: string;
  }>;
}) {
  const db = await getDb();
  const zip = await makeArchive({
    "profile.json": JSON.stringify({
      exportVersion: 2,
      exportDate: new Date(0).toISOString(),
      profile: { name: "Legacy profile", syncType: "local" },
      padConfigurations: data.padConfigurations,
      pageMetadata: data.pageMetadata,
      audioFiles: [],
    }),
  });

  await importProfilesFromZip(zip, db);

  const imported = (await db.getAll("profiles"))[0];
  const pageMetadata = await db.getAllFromIndex(
    "pageMetadata",
    "profileId",
    imported.id!,
  );
  const padConfigurations = await db.getAllFromIndex(
    "padConfigurations",
    "profileId",
    imported.id!,
  );

  return { pageMetadata, padConfigurations };
}

describe("exporting and re-importing a .iaz archive", () => {
  it("brings a profile back with its pads, sounds and settings", async () => {
    const { profileId } = await seedProfile("Show board", "horn");
    const { db, archive, results, imported, pads } = await roundTrip(profileId);

    expect(archive).toBeInstanceOf(Blob);
    expect(results).toHaveLength(1);
    expect(results[0].result).not.toBeInstanceOf(Error);
    // A second profile, because importing must never overwrite the original.
    expect(await db.getAll("profiles")).toHaveLength(2);
    expect(imported.name).toContain("Show board");
    expect(imported.activePadBehavior).toBe("restart");
    expect(imported.backupReminderPeriod).toBe(4321);
    // An import is not a link: it must not inherit where the donor synced.
    expect(imported.syncType).toBe("local");

    expect(pads).toHaveLength(1);
    expect(pads[0].padIndex).toBe(3);
    expect(pads[0].name).toBe("horn");
    expect(pads[0].playbackType).toBe("sequential");
    expect(pads[0].padGainDb).toBe(2);
  });

  it("re-keys the gain settings onto the new audio ids", async () => {
    // The `Record<audioFileId, …>` hazard: the imported file gets a fresh
    // autoincrement id, so a setting left under the donor's id attaches to
    // whatever sound happens to hold that number here.
    const { profileId } = await seedProfile("Gains", "stab");
    const { pads } = await roundTrip(profileId);

    const newAudioId = pads[0].audioFileIds![0];
    expect(pads[0].audioGainSettings).toEqual({ [newAudioId]: -4.5 });
  });

  it("carries the audio bytes, not just the reference", async () => {
    const { profileId } = await seedProfile("Bytes", "clap");
    const { db, pads } = await roundTrip(profileId);
    const audio = await db.get("audioFiles", pads[0].audioFileIds![0]);

    expect(audio?.name).toBe("clap.wav");
    expect(await audio!.blob.text()).toBe("bytes for clap");
  });

  it("keeps the bank name and its emergency flag", async () => {
    const { profileId } = await seedProfile("Banks", "sting");
    const { db, imported } = await roundTrip(profileId);
    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      imported.id!,
    );

    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("Opening");
    expect(pages[0].isEmergency).toBe(true);
  });

  it("carries the content hash, so a restore does not force a rehash", async () => {
    // Archives written before this carry none and still import; what must not
    // happen is a *new* archive losing a hash the exporting device had. A
    // hashless record makes the next sync that needs one read and SHA-256
    // every audio file in the library to build a fallback index.
    const db = await getDb();
    const { profileId, audioFileId } = await seedProfile("Hashed", "kick");
    const existing = (await db.get("audioFiles", audioFileId))!;
    await db.put("audioFiles", { ...existing, hash: "d".repeat(64) });

    const { pads } = await roundTrip(profileId);
    const audio = await db.get("audioFiles", pads[0].audioFileIds![0]);

    expect(audio?.hash).toBe("d".repeat(64));
  });

  it("stamps the sync bookkeeping the merge decides on", async () => {
    // Imported records used to carry no `_modified` and no `_fieldsModified`
    // at all. That is the entire basis `compareSyncableItems` compares on, so
    // an imported pad looked to a merge like it had never been touched — and
    // the first sync after an import could prefer a remote copy over the
    // sounds the user had just imported.
    const { profileId } = await seedProfile("Freshly imported", "tom");
    const { db, imported, pads } = await roundTrip(profileId);

    expect(pads[0]._modified).toBeGreaterThan(0);
    expect(pads[0]._created).toBeGreaterThan(0);
    // Every field counts as modified now, because it was: the record did not
    // exist a moment ago.
    expect(pads[0]._fieldsModified?.audioFileIds).toBeGreaterThan(0);
    expect(pads[0]._fieldsModified?.name).toBeGreaterThan(0);

    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      imported.id!,
    );
    expect(pages[0]._modified).toBeGreaterThan(0);
    expect(pages[0]._fieldsModified?.name).toBeGreaterThan(0);
  });

  it("carries a pad's own activePadBehavior override out and back", async () => {
    // The override is the pad's answer to "what happens when I hit this pad
    // while it is already playing", and it is written by hand into the pad
    // record the import builds — `importPadConfigurations` enumerates its
    // fields rather than spreading, so a field it forgets is dropped with no
    // compiler error. The export half spreads whole pad rows, so this case
    // covers both halves at once: it goes red if either stops carrying it.
    const { profileId, audioFileId } = await seedProfile("Layered", "clap");
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 3,
      audioFileIds: [audioFileId],
      playbackType: "sequential",
      activePadBehavior: "layer",
    });

    const { pads } = await roundTrip(profileId);

    expect(pads).toHaveLength(1);
    expect(pads[0].activePadBehavior).toBe("layer");
    // And it is a field the merge can be asked about, not just a value on the
    // record. An absent `_fieldsModified` entry is a losing vote, which is how
    // an imported pad lost its own disabled flag to a remote that had one.
    expect(pads[0]._fieldsModified?.activePadBehavior).toBeGreaterThan(0);
  });

  it("leaves a pad with no override following the profile", async () => {
    // Undefined is not "missing", it is the value that means "follow the
    // profile". Defaulting it on import would freeze the exporting profile's
    // setting onto every pad in the archive.
    const { profileId } = await seedProfile("Plain", "snare");
    const { pads } = await roundTrip(profileId);

    expect(pads[0].activePadBehavior).toBeUndefined();
  });

  it("round-trips several profiles in one archive", async () => {
    const db = await getDb();
    const a = await seedProfile("First", "one");
    const b = await seedProfile("Second", "two");

    const archive = await exportProfilesToZip(
      [a.profileId, b.profileId],
      "blob",
    );
    const results = await importProfilesFromZip(archive!, db);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !(r.result instanceof Error))).toBe(true);
    expect(await db.getAll("profiles")).toHaveLength(4);
  });

  it("gives an archive with no bankId the deterministic migrated id", async () => {
    // A file exported before bank identity existed. The import must reach
    // the same ids the v7 migration would, or the same board arrives twice.
    const restored = await roundTripLegacyProfile({
      pageMetadata: [{ pageIndex: 2, name: "Stings", isEmergency: false }],
      padConfigurations: [
        {
          pageIndex: 2,
          padIndex: 0,
          audioFileIds: [],
          playbackType: "sequential",
        },
      ],
    });

    expect(restored.pageMetadata[0].bankId).toBe("2");
    expect(restored.padConfigurations[0].bankId).toBe("2");
  });

  it("materialises a bank row for a pad position the archive never gave one", async () => {
    // Banks 1-10 used to be synthesised implicitly in the page component, so
    // a v6-era export can carry pads at a position with no `pageMetadata`
    // row of its own — here, position 4 has a pad but `pageMetadata` only
    // names position 2. Without materialising a row for it, the position-4
    // pad's `bankId` ("4") names no bank row at all and is unreachable in
    // the UI forever.
    const restored = await roundTripLegacyProfile({
      pageMetadata: [{ pageIndex: 2, name: "Stings", isEmergency: false }],
      padConfigurations: [
        {
          pageIndex: 4,
          padIndex: 0,
          audioFileIds: [],
          playbackType: "sequential",
        },
        {
          pageIndex: 2,
          padIndex: 0,
          audioFileIds: [],
          playbackType: "sequential",
        },
      ],
    });

    expect(restored.padConfigurations).toHaveLength(2);
    const bankIds = restored.pageMetadata.map((p) => p.bankId).sort();
    expect(bankIds).toEqual(["2", "4"]);
    // Every pad's bankId names a bank row that actually exists.
    for (const pad of restored.padConfigurations) {
      expect(bankIds).toContain(pad.bankId);
    }
  });
});

describe("importing an archive that is not what it claims", () => {
  it("names the entry that is not valid JSON", async () => {
    const db = await getDb();
    const zip = await makeArchive({ "profile.json": "{ not json" });

    await expect(importProfilesFromZip(zip, db)).rejects.toThrow(
      /profile\.json .* not valid JSON/,
    );
  });

  it("refuses an archive whose profile entry has no profile in it", async () => {
    const db = await getDb();
    const zip = await makeArchive({
      "profile.json": JSON.stringify({ exportVersion: 2 }),
    });

    await expect(importProfilesFromZip(zip, db)).rejects.toThrow(
      /no profile in it/,
    );
  });

  it("refuses a malformed pad list rather than writing from it", async () => {
    const db = await getDb();
    const zip = await makeArchive({
      "profile.json": JSON.stringify({
        exportVersion: 2,
        profile: { name: "Odd" },
        padConfigurations: "not an array",
      }),
    });

    await expect(importProfilesFromZip(zip, db)).rejects.toThrow(
      /malformed padConfigurations/,
    );
    // Nothing was written before the refusal.
    expect(await db.getAll("profiles")).toHaveLength(0);
  });

  it("refuses a pad with neither bankId nor pageIndex rather than filing it under bank 0", async () => {
    // Corrupt data, not a shape this schema has ever produced on purpose —
    // `withMigratedBankId` (syncUtils.ts) and `migrateToV7` pass 1
    // (dbMigrations/v7BankId.ts) both refuse to place it rather than
    // silently defaulting it into whatever bank sits at position 0. The
    // import must refuse the same way.
    const db = await getDb();
    const zip = await makeArchive({
      "profile.json": JSON.stringify({
        exportVersion: 2,
        profile: { name: "Corrupt" },
        pageMetadata: [{ pageIndex: 0, name: "Opening", isEmergency: false }],
        padConfigurations: [{ padIndex: 0, audioFileIds: [] }],
        audioFiles: [],
      }),
    });

    const results = await importProfilesFromZip(zip, db);

    expect(results[0].result).toBeInstanceOf(Error);
    expect((results[0].result as Error).message).toMatch(
      /no bank could be determined/,
    );
    // The whole profile was rolled back, not left with a hole in it.
    expect(await db.getAll("profiles")).toHaveLength(0);
  });

  it("names the bank the user sees, not its raw id, in a pad diagnostic", async () => {
    // A modern-format archive: the pad carries `bankId` directly, with no
    // `pageIndex` of its own, so a diagnostic can only name the bank by
    // looking its position up on the bank row. The pre-fix message read the
    // opaque `bankId` itself — useless to someone looking at bank numbers on
    // their board. Triggered here via the audio-id-mapping warning (a
    // referenced audio file the archive never included), which needs no
    // database write to fail and so isn't subject to fake-indexeddb's
    // transaction-abort race on a genuine constraint violation.
    const db = await getDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const zip = await makeArchive({
      "profile.json": JSON.stringify({
        exportVersion: 2,
        profile: { name: "Modern" },
        pageMetadata: [
          { bankId: "abc-123", pageIndex: 5, name: "Six", isEmergency: false },
        ],
        padConfigurations: [
          {
            bankId: "abc-123",
            padIndex: 0,
            audioFileIds: [999], // Not in audioFiles below — nothing to map to.
            playbackType: "sequential",
          },
        ],
        audioFiles: [],
      }),
    });

    const results = await importProfilesFromZip(zip, db);

    expect(results[0].result).not.toBeInstanceOf(Error);
    // Read before restoring: `mockRestore()` also resets `.mock.calls`.
    const mappingWarning = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .find((msg) => msg.includes("Could not map all audio IDs"));
    warnSpy.mockRestore();

    expect(mappingWarning).toBeDefined();
    // Position 5 (zero-based) is bank 6 in the UI.
    expect(mappingWarning).toMatch(/bank 6/);
    expect(mappingWarning).not.toContain("abc-123");
  });

  it("still refuses an archive with neither manifest nor profile", async () => {
    const db = await getDb();
    const zip = await makeArchive({ "readme.txt": "hello" });

    await expect(importProfilesFromZip(zip, db)).rejects.toThrow(
      /missing manifest\.json or profile\.json/,
    );
  });
});
