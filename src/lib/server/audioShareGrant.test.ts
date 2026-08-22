/**
 * Who a hosted sound may be served to, when the asker controls the sharing.
 *
 * `profileMayServeHash` asks "could this sound legitimately have been put on
 * this profile", and one of the ways to answer yes is "a current email-share
 * editor holds it". Inviting an email is unilateral — `upsertEmailShare`
 * writes the row on the inviter's say-so with no acceptance step — so that
 * branch let the owner of any profile manufacture its own grant: name a hash
 * you do not hold, invite the person who does, and the bucket hands it over.
 *
 * The branch is not removable, because it is what serves rows the migration
 * backfilled before `profile_audio.added_by` existed, which are NULL there and
 * have no other route. So it is confined to exactly those rows: every row
 * written since carries a real `added_by`, and an attacker's row is written
 * today.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, execute, getDb, queryOne } from "./db";
import { upsertUserFromGoogle } from "./users";
import { createProfile, updateProfile } from "./profiles";
import { upsertEmailShare } from "./shares";
import { profileMayServeHash } from "./audio";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const HASH = "a".repeat(64);

function user(sub: string, email: string) {
  return upsertUserFromGoogle({ sub, email, name: email, picture: null });
}

/** A reference row is the server's record that this user uploaded these bytes. */
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
    `INSERT INTO audio_references (hash, user_id, name, created_at)
     VALUES (?, ?, ?, ?)`,
    HASH,
    userId,
    "horn.wav",
    Date.now(),
  );
}

/** What `profile_audio` records as this sound's adder, which is the real subject. */
function recordedAdder(profileId: string): number | null {
  return (
    queryOne<{ added_by: number | null }>(
      "SELECT added_by FROM profile_audio WHERE profile_id = ? AND hash = ?",
      profileId,
      HASH,
    )?.added_by ?? null
  );
}

describe("profileMayServeHash and unilateral invites", () => {
  it("refuses a sound the owner named but only their invitee holds", () => {
    const victim = user("sub-victim", "victim@example.com");
    const attacker = user("sub-attacker", "attacker@example.com");
    giveReference(victim.id);

    const profile = createProfile({
      ownerId: attacker.id,
      name: "Bait",
      data: { audioFiles: [{ hash: HASH }] },
    } as never);

    // The whole attack: the invite needs no acceptance, so the attacker can
    // put the victim into the set of people whose holdings count.
    upsertEmailShare(profile.id, "victim@example.com", "editor", attacker.id);

    expect(profileMayServeHash(profile.id, attacker.id, HASH)).toBe(false);
  });

  it("refuses a row with no recorded adder, even to the owner", () => {
    // The cost of removing the email-editor branch, recorded rather than
    // hidden. `added_by` is NULL on two kinds of row: what migration 2
    // backfilled before migration 3 added the column, and anything written
    // through an anonymous link share (`route.ts` passes
    // `loaded.user?.id ?? null`). Neither says who attached the sound, so
    // neither can distinguish a collaborator's upload from an attacker naming
    // a stranger's hash — and `reindexProfileAudio` is INSERT OR IGNORE, so a
    // re-save does not fill it in.
    //
    // Serving these needs a grant the owner cannot manufacture, which means
    // share acceptance. Until then the honest answer is 404.
    const owner = user("sub-owner", "owner@example.com");
    const helper = user("sub-helper", "helper@example.com");
    giveReference(helper.id);

    const profile = createProfile({
      ownerId: owner.id,
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
    } as never);
    execute(
      "UPDATE profile_audio SET added_by = NULL WHERE profile_id = ? AND hash = ?",
      profile.id,
      HASH,
    );
    upsertEmailShare(profile.id, "helper@example.com", "editor", owner.id);

    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(false);
  });

  it("repairs a row with no recorded adder when its holder next saves", () => {
    // How legacy rows recover. Migration 2 backfilled `profile_audio` from
    // existing blobs before migration 3 added `added_by`, so those rows record
    // no act by anyone and cannot be served. They cannot be repaired by
    // guessing — but the holder saving the board IS the missing act, so the
    // write records it. An attacker cannot trigger this: the repair happens
    // only for a writer who actually holds the sound.
    const owner = user("sub-owner-3", "owner3@example.com");
    const helper = user("sub-helper-3", "helper3@example.com");
    giveReference(helper.id);

    const profile = createProfile({
      ownerId: owner.id,
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
    } as never);
    execute(
      "UPDATE profile_audio SET added_by = NULL WHERE profile_id = ? AND hash = ?",
      profile.id,
      HASH,
    );
    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(false);

    updateProfile(profile.id, {
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
      expectedVersion: 1,
      writerId: helper.id,
    });

    expect(recordedAdder(profile.id)).toBe(helper.id);
    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(true);
  });

  it("does not repair the row for a writer who does not hold the sound", () => {
    // The same write, by someone who does not hold the bytes, must leave the
    // column alone — otherwise the repair is the bypass again, with an extra
    // step.
    const owner = user("sub-owner-4", "owner4@example.com");
    const helper = user("sub-helper-4", "helper4@example.com");
    giveReference(helper.id);

    const profile = createProfile({
      ownerId: owner.id,
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
    } as never);
    execute(
      "UPDATE profile_audio SET added_by = NULL WHERE profile_id = ? AND hash = ?",
      profile.id,
      HASH,
    );

    updateProfile(profile.id, {
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
      expectedVersion: 1,
      writerId: owner.id,
    });

    // The stored column, not `profileMayServeHash`. Asserting the derived
    // answer here is vacuous: with the holder check gone `added_by` becomes
    // the owner, but the reference still belongs to the helper, so the answer
    // is false either way and the guard can be deleted with this test green.
    // Measured — `if (true || userHoldsReference(...))` left all five passing.
    expect(recordedAdder(profile.id)).toBeNull();
    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(false);
  });

  it("still serves a sound the recorded adder holds", () => {
    const owner = user("sub-owner-2", "owner2@example.com");
    const helper = user("sub-helper-2", "helper2@example.com");
    giveReference(helper.id);

    const profile = createProfile({
      ownerId: owner.id,
      name: "Board",
      data: { audioFiles: [{ hash: HASH }] },
    } as never);
    execute(
      "UPDATE profile_audio SET added_by = ? WHERE profile_id = ? AND hash = ?",
      helper.id,
      profile.id,
      HASH,
    );

    expect(profileMayServeHash(profile.id, owner.id, HASH)).toBe(true);
  });
});
