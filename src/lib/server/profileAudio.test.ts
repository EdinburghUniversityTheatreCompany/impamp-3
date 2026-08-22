/**
 * "Does any profile still play this sound?" — the question a hosted-audio
 * DELETE has to answer before dropping a bucket object.
 *
 * It used to be answered by `SELECT data FROM profiles` with no WHERE and no
 * LIMIT, materialising every blob in the deployment as a JS string and
 * JSON.parse-ing each one. node:sqlite is synchronous and Node is
 * single-threaded, so with a few hundred profiles that stopped the whole
 * process — every other user's request, every SSE heartbeat, the health check —
 * for the duration. At the 8 MB body cap it is a self-inflicted outage.
 *
 * It is an existence check, so it now has an index. These tests pin the thing
 * that makes an index dangerous: that it can drift from the blob it describes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, queryAll } from "./db";
import { upsertUserFromGoogle } from "./users";
import { createProfile, updateProfile, deleteProfile } from "./profiles";
import { upsertEmailShare } from "./shares";
import { deletingHashWouldSilenceAProfile } from "./audio";
import { execute } from "./db";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

function owner() {
  return upsertUserFromGoogle({
    sub: "google-sub-1",
    email: "owner@example.com",
    name: "Owner",
    picture: null,
  });
}

function stranger() {
  return upsertUserFromGoogle({
    sub: "google-sub-2",
    email: "stranger@example.com",
    name: "Stranger",
    picture: null,
  });
}

/** The server's record that this user uploaded these bytes. */
function giveReference(userId: number, hash: string) {
  execute(
    `INSERT OR IGNORE INTO audio_objects (hash, size_bytes, content_type, extension, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    hash,
    1024,
    "audio/wav",
    "wav",
    Date.now(),
  );
  execute(
    `INSERT INTO audio_references (hash, user_id, name, created_at)
     VALUES (?, ?, ?, ?)`,
    hash,
    userId,
    "sound.wav",
    Date.now(),
  );
}

const blobNaming = (...hashes: string[]) => ({
  _syncFormatVersion: 1,
  profile: { name: "Board" },
  padConfigurations: [],
  pageMetadata: [],
  audioFiles: hashes.map((hash, i) => ({
    id: i + 1,
    name: `sound-${i}.mp3`,
    type: "audio/mpeg",
    hash,
  })),
});

/**
 * Bound to the boards this caller's own reference serves. Every wider scope
 * tried so far let a stranger pin someone else's hosted audio forever — see
 * the DELETE tests in audio.api.test.ts.
 */
const wouldSilenceABoard = (hash: string, user: { id: number }) =>
  deletingHashWouldSilenceAProfile(user.id, hash);

describe("deletingHashWouldSilenceAProfile", () => {
  it("finds a sound a stored profile names", () => {
    const user = owner();
    createProfile({
      ownerId: user.id,
      name: "Board",
      data: blobNaming("hash-kick", "hash-snare"),
    });

    expect(wouldSilenceABoard("hash-kick", user)).toBe(true);
    expect(wouldSilenceABoard("hash-snare", user)).toBe(true);
    expect(wouldSilenceABoard("hash-never-used", user)).toBe(false);
  });

  it("forgets a sound the profile stops naming", () => {
    const user = owner();
    const profile = createProfile({
      ownerId: user.id,
      name: "Board",
      data: blobNaming("hash-kick", "hash-snare"),
    });

    const result = updateProfile(profile.id, {
      name: "Board",
      data: blobNaming("hash-kick"),
      expectedVersion: profile.version,
    });
    expect(result.status).toBe("ok");

    // The index is rebuilt from the blob on every write, so a removed sound
    // does not keep a bucket object alive forever.
    expect(wouldSilenceABoard("hash-kick", user)).toBe(true);
    expect(wouldSilenceABoard("hash-snare", user)).toBe(false);
  });

  it("forgets everything a deleted profile named", () => {
    const user = owner();
    const profile = createProfile({
      ownerId: user.id,
      name: "Board",
      data: blobNaming("hash-kick"),
    });

    deleteProfile(profile.id);

    // Relies on `PRAGMA foreign_keys = ON` plus ON DELETE CASCADE. Without the
    // pragma the rows would survive and every deleted profile would pin its
    // sounds in the bucket permanently.
    expect(wouldSilenceABoard("hash-kick", user)).toBe(false);
    expect(queryAll("SELECT 1 FROM profile_audio")).toHaveLength(0);
  });

  it("still sees a sound another profile names", () => {
    const user = owner();
    const a = createProfile({
      ownerId: user.id,
      name: "A",
      data: blobNaming("hash-shared"),
    });
    createProfile({
      ownerId: user.id,
      name: "B",
      data: blobNaming("hash-shared"),
    });

    deleteProfile(a.id);

    expect(wouldSilenceABoard("hash-shared", user)).toBe(true);
  });

  it("indexes nothing for a blob whose shape it does not recognise", () => {
    const user = owner();
    // A client of an unexpected age. Indexing must not throw on a write path.
    expect(() =>
      createProfile({
        ownerId: user.id,
        name: "Odd",
        data: { audioFiles: "not an array" },
      }),
    ).not.toThrow();

    expect(queryAll("SELECT 1 FROM profile_audio")).toHaveLength(0);
  });

  it("deduplicates a hash a blob names twice", () => {
    const user = owner();
    createProfile({
      ownerId: user.id,
      name: "Board",
      data: blobNaming("hash-dup", "hash-dup"),
    });

    expect(queryAll("SELECT 1 FROM profile_audio")).toHaveLength(1);
  });

  it("does not let an invitation nobody accepted pin a sound", () => {
    // The scope was "profiles you own or have been shared", and a share is
    // written unilaterally: `upsertEmailShare` inserts a row for any address
    // on the inviter's say-so, with no acceptance step and no notification. So
    // a stranger could reach into this answer — name your hash in a board of
    // their own, invite you to it, and your own file is pinned forever, in a
    // profile you never asked for and cannot make them delete.
    const victim = owner();
    const squatter = stranger();
    giveReference(victim.id, "hash-victims");

    const bait = createProfile({
      ownerId: squatter.id,
      name: "Bait",
      data: blobNaming("hash-victims"),
    });
    upsertEmailShare(bait.id, victim.email, "editor", squatter.id);

    expect(wouldSilenceABoard("hash-victims", victim)).toBe(false);
  });

  it("still refuses when the caller put the sound on someone else's board", () => {
    // The legitimate half of the same shape, and the reason the question is
    // not simply "do you own a profile that names it". A collaborator's
    // reference is what `profileMayServeHash` points at for a sound they
    // added, so letting them drop it silences the owner's board.
    const boardOwner = owner();
    const collaborator = stranger();
    giveReference(collaborator.id, "hash-contributed");

    const profile = createProfile({
      ownerId: boardOwner.id,
      name: "Show",
      data: blobNaming(),
    });
    upsertEmailShare(profile.id, collaborator.email, "editor", boardOwner.id);
    updateProfile(profile.id, {
      name: "Show",
      data: blobNaming("hash-contributed"),
      expectedVersion: profile.version,
      writerId: collaborator.id,
    });

    expect(wouldSilenceABoard("hash-contributed", collaborator)).toBe(true);
  });

  it("lets go of a copy the board does not depend on", () => {
    // Both of them uploaded the same sound. The owner holds a reference of
    // their own, so the board plays whatever the collaborator does with
    // theirs — refusing here would freeze quota to protect nothing.
    const boardOwner = owner();
    const collaborator = stranger();
    giveReference(boardOwner.id, "hash-both");
    giveReference(collaborator.id, "hash-both");

    const profile = createProfile({
      ownerId: boardOwner.id,
      name: "Show",
      data: blobNaming(),
    });
    upsertEmailShare(profile.id, collaborator.email, "editor", boardOwner.id);
    updateProfile(profile.id, {
      name: "Show",
      data: blobNaming("hash-both"),
      expectedVersion: profile.version,
      writerId: collaborator.id,
    });

    expect(wouldSilenceABoard("hash-both", collaborator)).toBe(false);
  });
});
