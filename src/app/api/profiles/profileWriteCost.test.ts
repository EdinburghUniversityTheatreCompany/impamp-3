/**
 * What one profile PUT costs the database, counted rather than asserted about.
 *
 * The blob is up to MAX_PROFILE_BODY_BYTES, and `SELECT *` on `profiles` walks
 * its overflow chain off disk and materialises it as a UTF-16 string —
 * synchronously, on the one thread serving everyone else, in a deployment that
 * runs as a single instance. So "how many times does a write read the blob it
 * is replacing?" is a number worth pinning, not a matter of taste.
 *
 * A statement census is the honest way to measure it: wall-clock timings on a
 * loaded machine say more about the machine, while the count of full-row reads
 * is the same on every machine and is the thing that scales with blob size.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every SQL statement the handler runs, in order. */
const statements: string[] = [];

vi.mock("@/lib/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/db")>();
  const record = <T extends unknown[], R>(fn: (sql: string, ...a: T) => R) =>
    ((sql: string, ...args: T) => {
      statements.push(sql);
      return fn(sql, ...args);
    }) as typeof fn;

  return {
    ...actual,
    queryOne: record(actual.queryOne),
    queryAll: record(actual.queryAll),
    execute: record(actual.execute),
  };
});

const { closeDb, getDb } = await import("@/lib/server/db");
const { createProfile } = await import("@/lib/server/profiles");
const { createSession } = await import("@/lib/server/session");
const { upsertUserFromGoogle } = await import("@/lib/server/users");
const { makeApiRequest, routeParams } =
  await import("@/lib/server/testSupport");
const { PUT: putProfile } = await import("./[id]/route");

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
  statements.length = 0;
});

/** How many statements read a whole profile row, blob and all. */
const fullBlobReads = () =>
  statements.filter((sql) => /SELECT \* FROM profiles\b/.test(sql)).length;

/** How many statements write to the audio index. */
const audioIndexWrites = () =>
  statements.filter((sql) => /(INSERT|DELETE)[\s\S]*profile_audio/i.test(sql))
    .length;

const blobNaming = (...hashes: string[]) => ({
  _syncFormatVersion: 1,
  padConfigurations: [],
  pageMetadata: [],
  audioFiles: hashes.map((hash, index) => ({
    id: index,
    name: `${hash}.mp3`,
    type: "audio/mpeg",
    hash,
  })),
});

function ownedProfile(...hashes: string[]) {
  const user = upsertUserFromGoogle({
    sub: "sub-1",
    email: "owner@example.com",
    name: "Owner",
    picture: null,
  });
  const profile = createProfile({
    ownerId: user.id,
    name: "Panto",
    data: blobNaming(...hashes),
  });
  return { user, profile, token: createSession(user.id) };
}

const put = (
  id: string,
  token: string,
  version: number,
  data: Record<string, unknown>,
) =>
  putProfile(
    makeApiRequest(`/api/profiles/${id}`, {
      method: "PUT",
      sessionToken: token,
      headers: { "if-match": `"${version}"` },
      body: { name: "Panto", data },
    }),
    routeParams({ id }),
  );

describe("what a profile PUT costs", () => {
  it("never reads the blob it is about to replace", async () => {
    const { profile, token } = ownedProfile("aaa");
    statements.length = 0;

    const response = await put(profile.id, token, 1, blobNaming("aaa"));

    expect(response.status).toBe(200);
    // Authorisation needs the owner id, the version check needs the version,
    // and the response needs neither — three answers, none of which is the
    // blob. Reading it three times to get them (twice while holding the write
    // lock) is what this pins.
    expect(fullBlobReads()).toBe(0);
  });

  it("reads it once when it has to hand it back", async () => {
    const { profile, token } = ownedProfile("aaa");
    statements.length = 0;

    // Stale: the 409 body carries the current blob, so this read is the one
    // that is actually needed.
    const response = await put(profile.id, token, 99, blobNaming("aaa"));

    expect(response.status).toBe(409);
    expect(fullBlobReads()).toBe(1);
  });

  it("leaves the audio index alone when the sounds have not changed", async () => {
    const { profile, token } = ownedProfile("aaa", "bbb");
    statements.length = 0;

    await put(profile.id, token, 1, blobNaming("aaa", "bbb"));

    // The overwhelmingly common write: a pad moved, a bank renamed, the same
    // sounds. Re-inserting every hash on every save is a write per sound per
    // save for a row that is already there.
    expect(audioIndexWrites()).toBe(0);
  });

  it("writes only the difference when the sounds do change", async () => {
    const { profile, token } = ownedProfile("aaa", "bbb");
    statements.length = 0;

    await put(profile.id, token, 1, blobNaming("aaa", "ccc"));

    // One DELETE for bbb, one INSERT for ccc. aaa is left alone — and must be,
    // because `added_by` records who first put it there.
    expect(audioIndexWrites()).toBe(2);
  });
});
