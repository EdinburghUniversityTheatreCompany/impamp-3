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
import { beforeEach, describe, expect, it } from "vitest";

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
    pageIndex: 0,
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

  it("still refuses an archive with neither manifest nor profile", async () => {
    const db = await getDb();
    const zip = await makeArchive({ "readme.txt": "hello" });

    await expect(importProfilesFromZip(zip, db)).rejects.toThrow(
      /missing manifest\.json or profile\.json/,
    );
  });
});

/** Builds a .iaz-shaped archive with exactly the entries given. */
async function makeArchive(entries: Record<string, string>): Promise<Blob> {
  const zipjs = await import("@zip.js/zip.js");
  zipjs.configure({ useWebWorkers: false });
  const writer = new zipjs.ZipWriter(new zipjs.BlobWriter("application/zip"));
  for (const [name, text] of Object.entries(entries)) {
    await writer.add(name, new zipjs.TextReader(text));
  }
  return writer.close();
}
