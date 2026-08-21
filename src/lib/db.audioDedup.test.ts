/**
 * Reuse of an audio row that already holds the same bytes.
 *
 * `addAudioFile` computes a content hash and then adds a row anyway, so the
 * same sound imported twice has always cost two blobs. The reuse rule lives
 * in a second function rather than inside `addAudioFile`, because the import
 * rollback deletes what it created and must never delete a row it reused.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The loudness pipeline, stubbed.
 *
 * `db.ts` imports it dynamically at call time, so `vi.doMock` registered here
 * — before `db.ts` itself is imported — is what the dynamic import resolves
 * to. Registering the spy is the only way to see that a *new* row is queued
 * for analysis and a *reused* one is not.
 */
const analyseAndStore = vi.fn(async () => null);
vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));

const {
  addAudioFile,
  addOrReuseAudioFile,
  addProfile,
  computeBlobHash,
  findAudioFileIdByHashIn,
  getDb,
  replaceMissingAudioFile,
  upsertPadConfiguration,
} = await import("./db");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** Bytes that are not the horn's, so a reuse of one for the other is visible. */
function stab(): Blob {
  return new Blob(["a completely different stab"], { type: "audio/wav" });
}

beforeEach(async () => {
  await clearAllStores();
  analyseAndStore.mockClear();
});

describe("addOrReuseAudioFile", () => {
  it("returns the id of the row that already holds these bytes", async () => {
    const first = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    const second = await addOrReuseAudioFile({
      name: "horn-copy.wav",
      type: "audio/wav",
      blob: horn(),
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });

  it("adds a row when the bytes are new", async () => {
    const first = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    const second = await addOrReuseAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });

    expect(second.reused).toBe(false);
    expect(second.id).not.toBe(first.id);

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(2);
  });

  it("reuses a row that `addAudioFile` wrote earlier", async () => {
    // The library a user already has was written by the old path. Reuse has
    // to see those rows, or the first import after the upgrade duplicates
    // every sound on the board.
    const oldId = await addAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });

    const result = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });

    expect(result).toEqual({ id: oldId, reused: true });
  });

  it("trusts a hash the caller supplies, and does not read the blob", async () => {
    // Sync and archive paths carry a hash with each reference. Trusting it
    // is what lets a shared sound be reused before its bytes are read. It is
    // also, precisely, what a SHA-256 collision would look like from inside
    // this function: equal hashes mean one row, and the second blob is
    // dropped.
    const declared = await computeBlobHash(horn());
    const first = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
      hash: declared,
    });

    const second = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: stab(),
      hash: declared,
    });

    expect(second).toEqual({ id: first.id, reused: true });
  });

  it("stores the hash on the row it creates", async () => {
    const { id } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });

    const db = await getDb();
    const record = await db.get("audioFiles", id);
    expect(record?.hash).toBe(await computeBlobHash(horn()));
  });

  it("leaves the row it reused exactly as it found it", async () => {
    // Reuse returns an id; it must not write the incoming metadata over the
    // row. That row may already carry a loudness analysis — the expensive
    // thing in the whole store — and the second caller's name is not more
    // correct than the first's.
    const first = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    const db = await getDb();
    const analysis = {
      algoVersion: 1,
      sampleRate: 48000,
      duration: 1,
      blockMeanSquare: new Float32Array([0.5]),
      hopTruePeak: new Float32Array([0.5]),
    };
    await db.put("audioFiles", {
      ...(await db.get("audioFiles", first.id))!,
      loudness: analysis,
    });

    await addOrReuseAudioFile({
      name: "renamed-by-the-second-caller.wav",
      type: "audio/ogg",
      blob: horn(),
    });

    const record = await db.get("audioFiles", first.id);
    expect(record?.name).toBe("horn.wav");
    expect(record?.type).toBe("audio/wav");
    expect(record?.loudness).toEqual(analysis);
  });

  it("computes the hash when the caller supplies an empty one", async () => {
    // An archive manifest and a sync blob are both unvalidated JSON, so an
    // empty `hash` can arrive. `??` would let it through, store a row under
    // the key "", and then collapse every later empty-hash file onto that one
    // row regardless of its bytes.
    const first = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
      hash: "",
    });
    const second = await addOrReuseAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
      hash: "",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.reused).toBe(false);

    const db = await getDb();
    expect((await db.get("audioFiles", first.id))?.hash).toBe(
      await computeBlobHash(horn()),
    );
  });

  it("queues analysis for a row it creates and not for one it reuses", async () => {
    const { id } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    await vi.waitFor(() => expect(analyseAndStore).toHaveBeenCalledWith(id));

    analyseAndStore.mockClear();
    await addOrReuseAudioFile({
      name: "horn-copy.wav",
      type: "audio/wav",
      blob: horn(),
    });
    // The reused row keeps the analysis it has. That each set of bytes is
    // analysed once is the whole saving.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(analyseAndStore).not.toHaveBeenCalled();
  });

  it("adds a row rather than reusing one whose hash was never stored", async () => {
    // A row written before the v5 hash index, or by a path that passed no
    // hash, carries none — and IndexedDB leaves such a row out of the index
    // entirely, so reuse cannot see it. It duplicates instead, which costs a
    // blob but never merges two sounds. The library-wide cleanup is what
    // collapses these.
    const db = await getDb();
    const hashless = await db.add("audioFiles", {
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
      createdAt: new Date(0),
    });

    const result = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });

    expect(result.reused).toBe(false);
    expect(result.id).not.toBe(hashless);
  });
});

describe("findAudioFileIdByHashIn", () => {
  /** Runs the lookup against the real `hash` index, in its own transaction. */
  async function lookup(hash: string): Promise<number | undefined> {
    const db = await getDb();
    const tx = db.transaction("audioFiles", "readonly");
    const id = await findAudioFileIdByHashIn(
      tx.objectStore("audioFiles").index("hash"),
      hash,
    );
    await tx.done;
    return id;
  }

  it("finds the row whose bytes hash to the key", async () => {
    const id = await addAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    await addAudioFile({ name: "stab.wav", type: "audio/wav", blob: stab() });

    expect(await lookup(await computeBlobHash(horn()))).toBe(id);
  });

  it("answers nothing for a hash no row holds", async () => {
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });

    expect(await lookup(await computeBlobHash(stab()))).toBeUndefined();
  });

  it("answers nothing rather than everything when the hash is missing", async () => {
    // `index.getAll(undefined)` is IndexedDB for "every row". A reference
    // whose hash never made it out of an archive manifest is typed `string`
    // and is not one, so without the guard the very first hashless reference
    // would be answered with whichever row the store returned first — two
    // unrelated sounds merged into one, unrecoverably.
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
    await addAudioFile({ name: "stab.wav", type: "audio/wav", blob: stab() });

    expect(await lookup(undefined as unknown as string)).toBeUndefined();
    expect(await lookup("")).toBeUndefined();
  });
});

describe("replaceMissingAudioFile", () => {
  it("points the pad at the row that already holds the bytes", async () => {
    // Repairing a broken reference means picking the file off disk again, so
    // the bytes are very often already in the library — under another pad, or
    // under this profile's own copy of the same sound. Adding a second row
    // for them is how a library grows a duplicate of everything a user has
    // ever re-linked.
    const db = await getDb();
    const profileId = await addProfile({ name: "Repair", syncType: "local" });
    const keeperId = await addAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Broken",
      audioFileIds: [999999],
      playbackType: "sequential",
    });

    const replacement = new File([horn()], "horn-again.wav", {
      type: "audio/wav",
    });
    await replaceMissingAudioFile(profileId, "0", 0, 999999, replacement);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads[0].audioFileIds).toEqual([keeperId]);
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });

  it("adds a row when the replacement is bytes the library has never held", async () => {
    // The other half: reuse must not swallow a genuine replacement. Without
    // this, a `replaceMissingAudioFile` that returned some arbitrary existing
    // id would still satisfy the test above.
    const db = await getDb();
    const profileId = await addProfile({ name: "Repair", syncType: "local" });
    const strangerId = await addAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Broken",
      audioFileIds: [999999],
      playbackType: "sequential",
    });

    const replacement = new File([stab()], "stab.wav", { type: "audio/wav" });
    await replaceMissingAudioFile(profileId, "0", 0, 999999, replacement);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads[0].audioFileIds).not.toEqual([strangerId]);
    expect(pads[0].audioFileIds).not.toEqual([999999]);
    expect(await db.getAll("audioFiles")).toHaveLength(2);
  });
});

/**
 * Deleting one profile must not take another profile's audio with it.
 *
 * `audioFiles` has no `profileId` and `addOrReuseAudioFile` takes no profile
 * argument, so reuse is unconditionally global: profile B's pad happily names
 * the row profile A created. Every path that removes an audio row therefore
 * has to decide by reference rather than by ownership, and each of them
 * already does — incidentally, because before reuse a row could only ever have
 * one profile's pads pointing at it. These tests are what turn that accident
 * into a rule, because the failure mode is a user deleting one show and losing
 * the sounds out of another.
 */
describe("audio shared between profiles", () => {
  /**
   * Two profiles whose pads name the very same audio row, plus one row only
   * the first profile names.
   *
   * The exclusive row is not decoration. Without it, "the shared row survived"
   * is also what a `deleteProfile` that deleted no audio at all would produce,
   * and the assertion could not tell the two apart.
   */
  async function twoProfilesOneSound() {
    const shared = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    const exclusive = await addOrReuseAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });
    // Different bytes must mean different rows, or every assertion below is
    // about one row wearing two names. A fixture whose two sounds are
    // byte-identical is this plan's recurring trap: reuse collapses them, and
    // every "the other row went" assertion silently becomes a no-op.
    expect(exclusive.id).not.toBe(shared.id);

    const profileIds: number[] = [];
    for (const name of ["Show A", "Show B"]) {
      const profileId = await addProfile({ name, syncType: "local" });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        name: "Horn",
        audioFileIds: [shared.id],
        playbackType: "sequential",
      });
      profileIds.push(profileId);
    }

    // Only Show A names the stab.
    await upsertPadConfiguration({
      profileId: profileIds[0],
      bankId: "0",
      padIndex: 1,
      name: "Stab",
      audioFileIds: [exclusive.id],
      playbackType: "sequential",
    });

    return {
      audioFileId: shared.id,
      exclusiveAudioFileId: exclusive.id,
      profileIds,
    };
  }

  it("keeps the sound when one of the two profiles is deleted", async () => {
    const { deleteProfile } = await import("./db");
    const db = await getDb();
    const { audioFileId, exclusiveAudioFileId, profileIds } =
      await twoProfilesOneSound();

    await deleteProfile(profileIds[0]);

    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
    // The other half, so that "kept everything" cannot pass as "kept the right
    // thing": the row only the deleted profile named is gone.
    expect(await db.get("audioFiles", exclusiveAudioFileId)).toBeUndefined();
  });

  it("deletes the sound when the last profile that names it goes", async () => {
    const { deleteProfile } = await import("./db");
    const db = await getDb();
    const { audioFileId, profileIds } = await twoProfilesOneSound();

    await deleteProfile(profileIds[0]);
    await deleteProfile(profileIds[1]);

    expect(await db.get("audioFiles", audioFileId)).toBeUndefined();
  });

  it("keeps a referenced row out of a rollback sweep", async () => {
    const { deleteUnreferencedAudioFiles } = await import("./db");
    const db = await getDb();
    const { audioFileId } = await twoProfilesOneSound();

    const removed = await deleteUnreferencedAudioFiles([audioFileId]);

    expect(removed).toBe(0);
    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
  });

  it("keeps a row that only another profile names out of a rollback sweep", async () => {
    // The shape a failed import actually has: the import into Show B reused a
    // row Show A had put there, then rolled back and handed the sweep every id
    // it touched. Nothing in Show B references the row by then — its pads are
    // gone — so a sweep that asked "does the profile I was importing into
    // still name this?" would delete Show A's sound.
    const { deleteProfile, deleteUnreferencedAudioFiles } =
      await import("./db");
    const db = await getDb();
    const { audioFileId, profileIds } = await twoProfilesOneSound();
    await deleteProfile(profileIds[1]);

    const removed = await deleteUnreferencedAudioFiles([audioFileId]);

    expect(removed).toBe(0);
    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
  });

  it("keeps a row that only another profile names out of the orphan sweep", async () => {
    // The "clean up unused audio" button scans every pad in the database, not
    // the open profile's. With reuse, the sound on screen may well be one
    // another profile put there.
    const { cleanupOrphanedAudioFiles, deleteProfile } = await import("./db");
    const db = await getDb();
    const { audioFileId, profileIds } = await twoProfilesOneSound();
    await deleteProfile(profileIds[1]);

    const result = await cleanupOrphanedAudioFiles();

    expect(result.deletedCount).toBe(0);
    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
  });

  it("keeps the sounds of a profile that was duplicated when the original goes", async () => {
    // A duplicate shares its rows rather than copying them — that is why it is
    // instant and costs no storage — so the copy is a second profile naming
    // the original's audio, made without any import or sync.
    const { deleteProfile, duplicateProfileLocally } = await import("./db");
    const db = await getDb();
    const { audioFileId, exclusiveAudioFileId, profileIds } =
      await twoProfilesOneSound();

    await duplicateProfileLocally(profileIds[0], "Show A (copy)");
    await deleteProfile(profileIds[0]);

    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
    // The one only Show A named is now named by the copy, so it survives too.
    expect(await db.get("audioFiles", exclusiveAudioFileId)).toBeDefined();
  });
});
