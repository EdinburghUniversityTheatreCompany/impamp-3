/**
 * What happens to `added_by` when a hash leaves the blob and comes back.
 *
 * `reindexProfileAudio` protects rows that *survive* a write, and that was the
 * whole protection. A hash absent from one save is deleted, and the next save
 * naming it again inserts a fresh row — so two ordinary saves by an owner, one
 * without the sound and one with it back, re-attributed a collaborator's sound
 * to the owner. Who holds no reference to it: 404 on their own board, and the
 * 409 that stops the real holder deleting the bytes flipped to "safe".
 *
 * The `profile_audio` row cannot simply outlive the blob, because
 * `profileNamesHash` reads that table to gate downloads and a row kept past
 * its hash would widen the gate. So the attribution is kept somewhere else
 * instead — `profile_audio_adders`, which the rebuild does not touch and no
 * download consults.
 *
 * That matters because "lost on a round trip" was never benign. It was
 * described as failing closed and self-healing, and it does neither on the
 * delete side: a NULL `added_by` is invisible to
 * `deletingHashWouldSilenceAProfile`, so the 409 that stops the real holder
 * deleting bytes a board still plays answers "safe to delete". Take that
 * offer and the object is gone, no holder remains, and the "a holder next
 * saves" repair can never fire. It hardened rather than healed — which is the
 * case pinned at the bottom of this file.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, execute, getDb, queryOne } from "./db";
import { upsertUserFromGoogle } from "./users";
import { createProfile, updateProfile } from "./profiles";
import { deletingHashWouldSilenceAProfile, profileMayServeHash } from "./audio";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const HASH = "c".repeat(64);

function user(sub: string, email: string) {
  return upsertUserFromGoogle({ sub, email, name: email, picture: null });
}

function giveReference(userId: number) {
  execute(
    `INSERT OR IGNORE INTO audio_objects (hash, size_bytes, content_type, extension, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    HASH,
    1024,
    "audio/wav",
    "wav",
    Date.now(),
  );
  execute(
    `INSERT INTO audio_references (hash, user_id, name, created_at) VALUES (?, ?, ?, ?)`,
    HASH,
    userId,
    "horn.wav",
    Date.now(),
  );
}

const adder = (id: string) =>
  queryOne<{ added_by: number | null }>(
    "SELECT added_by FROM profile_audio WHERE profile_id = ? AND hash = ?",
    id,
    HASH,
  )?.added_by ?? null;

/**
 * A board whose collaborator has put their own sound on it: the starting state
 * every case here diverges from.
 */
function boardWithCollaboratorsSound(tag: string) {
  const owner = user(`o-${tag}`, `owner-${tag}@example.com`);
  const helper = user(`h-${tag}`, `helper-${tag}@example.com`);
  giveReference(helper.id);

  const profile = createProfile({
    ownerId: owner.id,
    name: "B",
    data: { audioFiles: [] },
  } as never);
  save(profile.id, 1, [HASH], helper.id);

  return { owner, helper, profileId: profile.id };
}

/** One ordinary publish of a board naming these hashes. */
function save(
  profileId: string,
  expectedVersion: number,
  hashes: string[],
  writerId: number | null,
) {
  updateProfile(profileId, {
    name: "B",
    data: { audioFiles: hashes.map((hash) => ({ hash })) },
    expectedVersion,
    writerId,
  });
}

describe("attribution across a round trip", () => {
  it("is never mis-attributed when the hash leaves and returns", () => {
    const { owner, helper, profileId } = boardWithCollaboratorsSound("a");
    expect(adder(profileId)).toBe(helper.id);
    expect(profileMayServeHash(profileId, owner.id, HASH)).toBe(true);

    // Two ordinary saves by the owner: one without the hash, one with it back.
    save(profileId, 2, [], owner.id);
    save(profileId, 3, [HASH], owner.id);

    // Never the owner, who does not hold it — that is the state nothing could
    // recover from. It is the helper, carried across the round trip by
    // `profile_audio_adders`, because the fact worth keeping is who was
    // *witnessed* attaching the sound and that is not a fact the rebuild gets
    // to forget.
    expect(adder(profileId)).toBe(helper.id);
    expect(profileMayServeHash(profileId, owner.id, HASH)).toBe(true);
  });

  it("cannot be manufactured by an owner naming a hash nobody attached", () => {
    // The reason the carried-forward value is safe to trust: there is nothing
    // to carry unless somebody holding the bytes was seen putting them here.
    // An owner naming a stranger's hash writes no memory and reads none back.
    const owner = user("o-x", "owner-x@example.com");
    const stranger = user("s-x", "stranger-x@example.com");
    giveReference(stranger.id);

    const profile = createProfile({
      ownerId: owner.id,
      name: "B",
      data: { audioFiles: [] },
    } as never);
    save(profile.id, 1, [HASH], owner.id);

    expect(adder(profile.id)).toBeNull();
    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(false);
  });

  it("recovers when the holder saves again", () => {
    const { owner, helper, profileId } = boardWithCollaboratorsSound("b");
    save(profileId, 2, [], owner.id);
    save(profileId, 3, [HASH], owner.id);

    save(profileId, 4, [HASH], helper.id);

    expect(adder(profileId)).toBe(helper.id);
    expect(profileMayServeHash(profileId, owner.id, HASH)).toBe(true);
  });

  it("repairs a row whose recorded adder no longer holds the sound", () => {
    // The case only the second half of the fix reaches, and the one that makes
    // `added_by IS NULL` the wrong gate: the row names a real adder who has
    // since deleted their copy. Just as unservable as naming nobody, and just
    // as repairable — by the same act, a holder saving.
    const { owner, helper, profileId } = boardWithCollaboratorsSound("c");
    expect(adder(profileId)).toBe(helper.id);

    execute(
      "DELETE FROM audio_references WHERE user_id = ? AND hash = ?",
      helper.id,
      HASH,
    );
    expect(profileMayServeHash(profileId, owner.id, HASH)).toBe(false);

    // A DIFFERENT collaborator, who does hold the bytes, saves. Re-testing the
    // original adder would prove nothing: their own re-upload makes the stale
    // value valid again without any repair happening, so the test passed
    // either way until this was changed.
    const second = user("h-c2", "helper-c2@example.com");
    giveReference(second.id);
    save(profileId, 2, [HASH], second.id);

    expect(adder(profileId)).toBe(second.id);
    expect(profileMayServeHash(profileId, owner.id, HASH)).toBe(true);
  });

  it("still refuses the holder's delete after a round trip", () => {
    // The half of the old residual that destroyed data. `added_by` went NULL,
    // which made the row invisible to `deletingHashWouldSilenceAProfile` — so
    // the holder was told the bytes a live board still names were safe to
    // delete. Nothing recovers from taking that offer: the object is removed,
    // no holder is left, and the repair the design leans on needs a holder.
    const { owner, helper, profileId } = boardWithCollaboratorsSound("d");
    expect(deletingHashWouldSilenceAProfile(helper.id, HASH)).toBe(true);

    save(profileId, 2, [], owner.id);
    save(profileId, 3, [HASH], owner.id);

    expect(deletingHashWouldSilenceAProfile(helper.id, HASH)).toBe(true);
  });

  it("allows the delete once the board really stops naming the sound", () => {
    // The other direction, so the guard above is not simply "always true":
    // remembering who attached a sound must not pin their bytes after the
    // board it was on has let it go.
    const { helper, profileId, owner } = boardWithCollaboratorsSound("e");
    save(profileId, 2, [], owner.id);

    expect(deletingHashWouldSilenceAProfile(helper.id, HASH)).toBe(false);
  });
});
