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
import { hashIsUsedByReachableProfile } from "./audio";

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
 * Bound to the profiles this caller can reach. The unscoped version let a
 * stranger's board pin someone else's hosted audio forever — see the DELETE
 * tests in audio.api.test.ts.
 */
const usedByOwner = (hash: string, user: { id: number; email: string }) =>
  hashIsUsedByReachableProfile(hash, user.id, user.email);

describe("hashIsUsedByReachableProfile", () => {
  it("finds a sound a stored profile names", () => {
    const user = owner();
    createProfile({
      ownerId: user.id,
      name: "Board",
      data: blobNaming("hash-kick", "hash-snare"),
    });

    expect(usedByOwner("hash-kick", user)).toBe(true);
    expect(usedByOwner("hash-snare", user)).toBe(true);
    expect(usedByOwner("hash-never-used", user)).toBe(false);
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
    expect(usedByOwner("hash-kick", user)).toBe(true);
    expect(usedByOwner("hash-snare", user)).toBe(false);
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
    expect(usedByOwner("hash-kick", user)).toBe(false);
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

    expect(usedByOwner("hash-shared", user)).toBe(true);
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
});
