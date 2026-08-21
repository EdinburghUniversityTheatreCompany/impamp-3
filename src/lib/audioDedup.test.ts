/**
 * Finding the duplicate audio rows a library has already accumulated.
 *
 * Audio rows are global, and until reuse landed every import wrote a fresh
 * blob for a sound the library already held. This half only *reports* the
 * groups; the collapse that acts on them is separate, so the report can be
 * shown to a user before anything is deleted.
 *
 * The hard cases are not the obvious pair. They are the rows written before
 * the `hash` field existed — invisible to the `hash` index, and a large part
 * of why this exists — and the rows carrying an empty hash, which is a valid
 * IndexedDB key and so would group every unrelated sound into one "duplicate".
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Type-only, so it is erased before runtime and cannot defeat the ordering
// the comment above describes.
import type { PadConfiguration } from "./db";

/**
 * The loudness pipeline, stubbed.
 *
 * `db.ts` imports it dynamically at call time, so `vi.doMock` registered here
 * — before `db.ts` itself is imported — is what the dynamic import resolves
 * to. Without it every `addAudioFile` fires a real background analysis that
 * reaches Web Audio, which node does not have, and the election tests below
 * turn on whether a row carries an analysis: a stray write racing the
 * assertions is exactly the flake that would be blamed on the fixture.
 */
const analyseAndStore = vi.fn(async () => null);
vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));

const { collapseDuplicateAudioGroups, findDuplicateAudioGroups } =
  await import("./audioDedup");
const {
  addAudioFile,
  addProfile,
  computeBlobHash,
  getDb,
  upsertPadConfiguration,
} = await import("./db");
const { clearLoudnessCache, getCachedLoudness, setCachedLoudness } =
  await import("./audio/loudness/cache");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** Bytes that are not the horn's, so grouping the two would be visible. */
function stab(): Blob {
  return new Blob(["a completely different stab"], { type: "audio/wav" });
}

/** A loudness analysis, in the smallest shape the type accepts. */
function someAnalysis() {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration: 1,
    blockMeanSquare: new Float32Array([0.5]),
    hopTruePeak: new Float32Array([0.5]),
  };
}

/**
 * Writes a row straight to the store, bypassing `addAudioFile`.
 *
 * `addAudioFile` always computes and stores a hash, so it cannot produce the
 * rows this module exists to find. Going round it is the only way to build a
 * pre-v5 row, or one whose hash arrived empty from unvalidated JSON.
 */
async function putRawRow(row: {
  name: string;
  blob: Blob;
  hash?: string;
}): Promise<number> {
  const db = await getDb();
  return db.add("audioFiles", {
    name: row.name,
    type: "audio/wav",
    blob: row.blob,
    ...(row.hash === undefined ? {} : { hash: row.hash }),
    createdAt: new Date(0),
  });
}

/** Two rows holding the same bytes. `addAudioFile` never reuses, by design. */
async function twoCopiesOfTheHorn(): Promise<[number, number]> {
  const first = await addAudioFile({
    name: "horn.wav",
    type: "audio/wav",
    blob: horn(),
  });
  const second = await addAudioFile({
    name: "horn (1).wav",
    type: "audio/wav",
    blob: horn(),
  });
  expect(second).not.toBe(first);
  return [first, second];
}

beforeEach(async () => {
  await clearAllStores();
  analyseAndStore.mockClear();
});

describe("findDuplicateAudioGroups", () => {
  it("reports nothing when every row is unique", async () => {
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
    await addAudioFile({ name: "stab.wav", type: "audio/wav", blob: stab() });

    expect(await findDuplicateAudioGroups()).toEqual([]);
  });

  it("groups rows that hold the same bytes and elects the lowest id", async () => {
    const [first, second] = await twoCopiesOfTheHorn();

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].hash).toBe(await computeBlobHash(horn()));
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second]);
    expect(groups[0].reclaimableBytes).toBe(horn().size);
  });

  it("prefers a row that already carries a loudness analysis", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    const db = await getDb();
    const analysed = (await db.get("audioFiles", second))!;
    await db.put("audioFiles", { ...analysed, loudness: someAnalysis() });

    const groups = await findDuplicateAudioGroups();

    // The analysis is the expensive part, so the row that has one wins even
    // though its id is higher.
    expect(groups[0].canonicalId).toBe(second);
    expect(groups[0].duplicateIds).toEqual([first]);
  });

  it("hashes a row that has none before it groups", async () => {
    // Rows written before the hash field existed carry none, and IndexedDB
    // omits a record whose key path is undefined — so an index scan sees no
    // rows at all and would report a clean database on the very libraries
    // that need the cleanup most.
    const first = await putRawRow({ name: "horn.wav", blob: horn() });
    const second = await putRawRow({ name: "horn (1).wav", blob: horn() });

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second]);

    // The hash is written back, not just used in passing: the collapse and
    // every later reuse read it from the row.
    const db = await getDb();
    const hornHash = await computeBlobHash(horn());
    expect((await db.get("audioFiles", first))?.hash).toBe(hornHash);
    expect((await db.get("audioFiles", second))?.hash).toBe(hornHash);
  });

  it("elects the lowest id when the hashed copy was scanned first", async () => {
    // The mixed library is the realistic one: an old row with no hash beside
    // a newer row that has one. The scan can only reach the hashless row
    // after it has read a blob and hashed it, so the group is assembled out
    // of id order and the election cannot lean on the order rows arrived in.
    const hashless = await putRawRow({ name: "horn.wav", blob: horn() });
    const hashed = await putRawRow({
      name: "horn (1).wav",
      blob: horn(),
      hash: await computeBlobHash(horn()),
    });
    expect(hashless).toBeLessThan(hashed);

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(hashless);
    expect(groups[0].duplicateIds).toEqual([hashed]);
  });

  it("does not group two different sounds that both carry an empty hash", async () => {
    // `""` is a valid IndexedDB key and a valid Map key, so an empty hash
    // taken at face value collapses every unhashed sound into one group —
    // and the collapse acting on that would delete unrelated audio. A missing
    // hash must mean "no match", never "matches everything".
    const hornId = await putRawRow({
      name: "horn.wav",
      blob: horn(),
      hash: "",
    });
    const stabId = await putRawRow({
      name: "stab.wav",
      blob: stab(),
      hash: "",
    });

    expect(await findDuplicateAudioGroups()).toEqual([]);

    const db = await getDb();
    expect((await db.get("audioFiles", hornId))?.hash).toBe(
      await computeBlobHash(horn()),
    );
    expect((await db.get("audioFiles", stabId))?.hash).toBe(
      await computeBlobHash(stab()),
    );
  });

  it("lists every duplicate in a group of three and sums their bytes", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    const third = await addAudioFile({
      name: "horn (2).wav",
      type: "audio/wav",
      blob: horn(),
    });

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second, third]);
    expect(groups[0].reclaimableBytes).toBe(horn().size * 2);
  });

  it("reports each set of identical bytes as its own group", async () => {
    const [firstHorn, secondHorn] = await twoCopiesOfTheHorn();
    const firstStab = await addAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });
    const secondStab = await addAudioFile({
      name: "stab (1).wav",
      type: "audio/wav",
      blob: stab(),
    });
    const unique = await addAudioFile({
      name: "riser.wav",
      type: "audio/wav",
      blob: new Blob(["a long slow riser"], { type: "audio/wav" }),
    });

    const groups = await findDuplicateAudioGroups();

    expect(
      groups.map((group) => [group.canonicalId, group.duplicateIds]),
    ).toEqual([
      [firstHorn, [secondHorn]],
      [firstStab, [secondStab]],
    ]);
    expect(groups.flatMap((group) => group.duplicateIds)).not.toContain(unique);
  });
});

describe("collapseDuplicateAudioGroups", () => {
  /** Three rows holding the horn's bytes: the survivor and two duplicates. */
  async function threeCopiesOfTheHorn(): Promise<[number, number, number]> {
    const [first, second] = await twoCopiesOfTheHorn();
    const third = await addAudioFile({
      name: "horn (2).wav",
      type: "audio/wav",
      blob: horn(),
    });
    expect(third).not.toBe(second);
    return [first, second, third];
  }

  /** A pad on the duplicate row, with a trim and a gain keyed by that id. */
  async function padOnTheDuplicate(
    duplicateId: number,
    profileName = "Show",
  ): Promise<number> {
    const profileId = await addProfile({
      name: profileName,
      syncType: "local",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 2,
      name: "Horn",
      audioFileIds: [duplicateId],
      audioTrimSettings: { [duplicateId]: { trimStart: 0.5, trimEnd: 2.5 } },
      audioGainSettings: { [duplicateId]: -4.5 },
      padGainDb: 3,
      playbackType: "sequential",
    });
    return profileId;
  }

  /**
   * A pad on the pre-V3 shape: the singular `audioFileId` and no array.
   *
   * `PadConfiguration` has not declared that field since V3, so the row has to
   * be written straight to the store. Such rows genuinely survive —
   * `migrateStoreV4` catches a per-record update error and carries on — which
   * is why `collectReferencedAudioFileIds` still knows about them.
   */
  async function padWithLegacyScalar(audioFileId: number): Promise<number> {
    const profileId = await addProfile({ name: "Legacy", syncType: "local" });
    const db = await getDb();
    await db.add("padConfigurations", {
      profileId,
      bankId: "0",
      padIndex: 1,
      name: "Old horn",
      audioFileId,
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as unknown as PadConfiguration);
    return profileId;
  }

  async function padsOf(profileId: number): Promise<PadConfiguration[]> {
    const db = await getDb();
    return db.getAllFromIndex("padConfigurations", "profileId", profileId);
  }

  beforeEach(() => {
    clearLoudnessCache();
  });

  it("does nothing when there is nothing to collapse", async () => {
    const db = await getDb();
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });

    const result = await collapseDuplicateAudioGroups(
      await findDuplicateAudioGroups(),
    );

    expect(result).toEqual({ removedFiles: 0, reclaimedBytes: 0 });
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });

  it("points the pad at the survivor and deletes the duplicate", async () => {
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);

    const result = await collapseDuplicateAudioGroups(
      await findDuplicateAudioGroups(),
    );

    expect(result.removedFiles).toBe(1);
    expect(result.reclaimedBytes).toBe(horn().size);
    expect(await db.get("audioFiles", second)).toBeUndefined();
    expect(await db.get("audioFiles", first)).toBeDefined();
    expect((await padsOf(profileId))[0].audioFileIds).toEqual([first]);
  });

  it("carries the per-sound trim and gain onto the survivor's id", async () => {
    // The five-places hazard. A hand-rolled copy of this loop is how a
    // duplicated profile lost every gain setting once already.
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    const pad = (await padsOf(profileId))[0];
    expect(pad.audioTrimSettings).toEqual({
      [first]: { trimStart: 0.5, trimEnd: 2.5 },
    });
    expect(pad.audioGainSettings).toEqual({ [first]: -4.5 });
    expect(pad.padGainDb).toBe(3);
  });

  it("keeps a setting whose id is not part of any group", async () => {
    // "keep" is the right mode for this remap. "drop" would delete every
    // setting on a pad whose sound was never duplicated.
    const [first, second] = await twoCopiesOfTheHorn();
    const untouched = await addAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });
    expect(untouched).not.toBe(second);
    const profileId = await addProfile({ name: "Show", syncType: "local" });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Two sounds",
      audioFileIds: [second, untouched],
      audioGainSettings: { [second]: -4.5, [untouched]: 1.5 },
      playbackType: "round-robin",
    });

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    const pad = (await padsOf(profileId))[0];
    expect(pad.audioFileIds).toEqual([first, untouched]);
    expect(pad.audioGainSettings).toEqual({ [first]: -4.5, [untouched]: 1.5 });
  });

  it("lists the survivor once when a pad named both rows", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await addProfile({ name: "Show", syncType: "local" });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Both",
      audioFileIds: [first, second],
      playbackType: "round-robin",
    });

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    expect((await padsOf(profileId))[0].audioFileIds).toEqual([first]);
  });

  it("keeps the survivor's own trim when the pad named both rows", async () => {
    // Two ids that become one id can carry two different trims, and only one
    // can survive: the settings maps are keyed by audio file id. Nothing can
    // reconcile that, so the only question is whether the outcome is decided
    // or accidental. The survivor's own entry wins.
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await addProfile({ name: "Show", syncType: "local" });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Both",
      audioFileIds: [first, second],
      audioTrimSettings: {
        [first]: { trimStart: 0, trimEnd: 1 },
        [second]: { trimStart: 2, trimEnd: 3 },
      },
      audioGainSettings: { [first]: -1, [second]: -9 },
      playbackType: "round-robin",
    });

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    const pad = (await padsOf(profileId))[0];
    expect(pad.audioTrimSettings).toEqual({
      [first]: { trimStart: 0, trimEnd: 1 },
    });
    expect(pad.audioGainSettings).toEqual({ [first]: -1 });
  });

  it("collapses a group that spans two profiles without either losing audio", async () => {
    // Audio rows are global and carry no profileId, so one group routinely
    // spans profiles — and a remap that walked only the active profile's pads
    // would delete the row the other profile's pad still names.
    const db = await getDb();
    const [canonical, dupA, dupB] = await threeCopiesOfTheHorn();
    const exclusiveA = await addAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });
    const exclusiveB = await addAudioFile({
      name: "riser.wav",
      type: "audio/wav",
      blob: new Blob(["a long slow riser"], { type: "audio/wav" }),
    });
    // The trap this branch has walked into three times: a helper that derives
    // bytes from duration alone makes two "different" sounds identical, and
    // they deduplicate into one row. Different content, and proved different.
    expect(exclusiveA).not.toBe(exclusiveB);

    const profileA = await addProfile({ name: "A", syncType: "local" });
    await upsertPadConfiguration({
      profileId: profileA,
      bankId: "0",
      padIndex: 0,
      name: "A horn",
      audioFileIds: [dupA, exclusiveA],
      audioGainSettings: { [dupA]: -2, [exclusiveA]: 4 },
      playbackType: "round-robin",
    });
    const profileB = await addProfile({ name: "B", syncType: "local" });
    await upsertPadConfiguration({
      profileId: profileB,
      bankId: "0",
      padIndex: 5,
      name: "B horn",
      audioFileIds: [dupB, exclusiveB],
      audioTrimSettings: { [dupB]: { trimStart: 1, trimEnd: 2 } },
      playbackType: "sequential",
    });

    const result = await collapseDuplicateAudioGroups(
      await findDuplicateAudioGroups(),
    );

    expect(result.removedFiles).toBe(2);
    const padA = (await padsOf(profileA))[0];
    const padB = (await padsOf(profileB))[0];
    expect(padA.audioFileIds).toEqual([canonical, exclusiveA]);
    expect(padB.audioFileIds).toEqual([canonical, exclusiveB]);
    expect(padA.audioGainSettings).toEqual({
      [canonical]: -2,
      [exclusiveA]: 4,
    });
    expect(padB.audioTrimSettings).toEqual({
      [canonical]: { trimStart: 1, trimEnd: 2 },
    });

    // Every id either pad still names must resolve to a row that exists.
    for (const id of [...padA.audioFileIds, ...padB.audioFileIds]) {
      expect(await db.get("audioFiles", id)).toBeDefined();
    }
    expect(await db.get("audioFiles", dupA)).toBeUndefined();
    expect(await db.get("audioFiles", dupB)).toBeUndefined();
  });

  it("remaps the pre-V3 singular audioFileId", async () => {
    // A pad whose V4 rewrite failed keeps the old shape forever, and it is
    // still a live reference — `collectReferencedAudioFileIds` says so. Read
    // only through `audioFileIds`, such a pad is skipped by the remap and then
    // has its row deleted underneath it: silent loss, on the oldest databases,
    // which are also the most duplicated.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await padWithLegacyScalar(second);

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    const pad = (await padsOf(profileId))[0] as PadConfiguration & {
      audioFileId?: number;
    };
    expect(pad.audioFileId).toBe(first);
    // Whatever the remap did, the sound this pad plays must still exist.
    expect(await db.get("audioFiles", pad.audioFileId!)).toBeDefined();
  });

  it("never deletes the row it elected, even when the group names it too", async () => {
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);

    const result = await collapseDuplicateAudioGroups([
      {
        hash: await computeBlobHash(horn()),
        canonicalId: first,
        duplicateIds: [second, first],
        reclaimableBytes: horn().size * 2,
      },
    ]);

    expect(result.removedFiles).toBe(1);
    expect(await db.get("audioFiles", first)).toBeDefined();
    expect(await db.get("audioFiles", second)).toBeUndefined();
    expect((await padsOf(profileId))[0].audioFileIds).toEqual([first]);
  });

  it("merges the duplicate's Drive file ids onto the survivor", async () => {
    // `driveFileIds` is keyed by profileId, so two rows holding the same bytes
    // can each be the only route back to Drive for a different profile.
    // Deleting one without merging strands that profile's audio and gets the
    // bytes re-uploaded.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", first))!,
      driveFileIds: { 1: "drive-for-profile-1" },
    });
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", second))!,
      driveFileIds: { 2: "drive-for-profile-2" },
    });

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    expect((await db.get("audioFiles", first))?.driveFileIds).toEqual({
      1: "drive-for-profile-1",
      2: "drive-for-profile-2",
    });
  });

  it("carries serverHosted onto the survivor", async () => {
    // Lost, the bytes are re-uploaded and the hosted quota is charged twice.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", second))!,
      serverHosted: true,
    });

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    expect((await db.get("audioFiles", first))?.serverHosted).toBe(true);
  });

  it("keeps a loudness analysis only the deleted row carried", async () => {
    // The election prefers an analysed row, so this needs a hand-built group —
    // which is exactly what the caller passes after a preview it may have been
    // sitting on. The analysis measures the bytes, and both rows hold the same
    // bytes, so it is always safe to inherit.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", second))!,
      loudness: someAnalysis(),
    });

    await collapseDuplicateAudioGroups([
      {
        hash: await computeBlobHash(horn()),
        canonicalId: first,
        duplicateIds: [second],
        reclaimableBytes: horn().size,
      },
    ]);

    expect((await db.get("audioFiles", first))?.loudness).toBeDefined();
  });

  it("skips a group whose survivor has gone since the preview", async () => {
    // The preview and the confirmation are separated by a dialog. A new
    // matching row arriving in that gap is harmless — it simply is not
    // collapsed — but a *deleted* canonical is not: pointing every pad at a
    // row that no longer exists is a board of silent pads.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);
    const groups = await findDuplicateAudioGroups();
    await db.delete("audioFiles", first);

    const result = await collapseDuplicateAudioGroups(groups);

    expect(result).toEqual({ removedFiles: 0, reclaimedBytes: 0 });
    expect(await db.get("audioFiles", second)).toBeDefined();
    expect((await padsOf(profileId))[0].audioFileIds).toEqual([second]);
  });

  it("re-warms the loudness cache onto the survivor", async () => {
    // The cache is a plain Map read *synchronously* at trigger time, and only
    // profile activation refills it. A pad repointed at a canonical that is
    // not in it resolves gain from nothing — normalisation silently reverts to
    // 0 dB for the rest of the session, which on a live board is a cue at the
    // wrong level with no error anywhere.
    const db = await getDb();
    const [first, second] = await twoCopiesOfTheHorn();
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", first))!,
      loudness: someAnalysis(),
    });
    await padOnTheDuplicate(second);
    expect(getCachedLoudness(first)).toBeUndefined();

    await collapseDuplicateAudioGroups([
      {
        hash: await computeBlobHash(horn()),
        canonicalId: first,
        duplicateIds: [second],
        reclaimableBytes: horn().size,
      },
    ]);

    expect(getCachedLoudness(first)).toEqual(someAnalysis());
  });

  it("drops the deleted rows from the loudness cache", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    setCachedLoudness(second, someAnalysis());

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    expect(getCachedLoudness(second)).toBeUndefined();
    // What was measured is not lost: it describes the bytes, and the survivor
    // holds the same bytes.
    expect(getCachedLoudness(first)).toEqual(someAnalysis());
  });

  it("leaves the sync stamps alone, because no other device can see this", async () => {
    // A pad travels by content *hash*, and every row in a group shares one —
    // so the wire form after a collapse is byte-identical to the wire form
    // before it. Stamping anyway would be worse than useless: `audioFileIds`
    // holds this device's autoIncrement keys, so it differs from every other
    // device's copy already, and a fresh stamp on both sides is precisely the
    // condition `compareItem` raises as a conflict needing manual resolution.
    // `updatedAt` is still moved: the row did change, and
    // `hasProfileChangedSince` reads it, so a backup reminder is honest.
    const [, second] = await twoCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);
    const before = (await padsOf(profileId))[0];

    await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

    const after = (await padsOf(profileId))[0];
    expect(after._modified).toBe(before._modified);
    expect(after._fieldsModified).toEqual(before._fieldsModified);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
  });

  it("sums the bytes of every row it actually removed", async () => {
    const [, second, third] = await threeCopiesOfTheHorn();
    const profileId = await padOnTheDuplicate(second);

    const result = await collapseDuplicateAudioGroups(
      await findDuplicateAudioGroups(),
    );

    expect(result).toEqual({
      removedFiles: 2,
      reclaimedBytes: horn().size * 2,
    });
    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(1);
    expect((await padsOf(profileId))[0].audioFileIds).toHaveLength(1);
    expect(third).not.toBe(second);
  });
});
