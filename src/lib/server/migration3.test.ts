/**
 * Migration 3 against a database that already has profiles in it.
 *
 * This is the upgrade path that will actually run on the deployed instance, and
 * it is the half a fresh-database test cannot reach: the `profile_audio` index
 * is only useful if it starts out describing the blobs that were already
 * stored. A migration that throws also takes the whole app down at boot, so the
 * malformed-blob case matters more here than anywhere else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, queryAll, queryOne } from "./db";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

let dir: string;
let dbPath: string;

/** The schema exactly as it stood at user_version 2, before this change. */
const SCHEMA_V2 = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE, name TEXT, picture TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0, can_upload_audio INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  audio_quota_bytes INTEGER
);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

const blob = (...hashes: string[]) =>
  JSON.stringify({
    audioFiles: hashes.map((hash, i) => ({ id: i, name: `s${i}`, hash })),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "impamp-migration-"));
  dbPath = join(dir, "impamp.db");

  const seed = new DatabaseSync(dbPath);
  seed.exec(SCHEMA_V2);
  seed.exec(
    `INSERT INTO users (id, google_sub, email, created_at, updated_at)
     VALUES (1, 'sub', 'owner@example.com', 0, 0)`,
  );
  const insert = seed.prepare(
    `INSERT INTO profiles (id, owner_id, name, data, version, created_at, updated_at)
     VALUES (?, 1, ?, ?, 1, 0, 0)`,
  );
  insert.run("p-normal", "Normal", blob("hash-kick", "hash-snare"));
  insert.run("p-shares", "Shares", blob("hash-kick"));
  insert.run("p-none", "No audio", JSON.stringify({ audioFiles: [] }));
  // The rows that could take the migration — and therefore app boot — down.
  insert.run("p-broken", "Unparseable", "this is not json");
  insert.run("p-oddshape", "Odd shape", JSON.stringify({ audioFiles: 42 }));
  insert.run("p-nohashes", "No hashes", JSON.stringify({ audioFiles: [{}] }));
  seed.exec("PRAGMA user_version = 2");
  seed.close();
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Points the memoised connection at this test's database and migrates it. */
function migrate() {
  closeDb();
  process.env.IMPAMP_DB_PATH = dbPath;
  getDb();
}

describe("migrating a populated database to user_version 3", () => {
  it("backfills the index from the blobs already stored", () => {
    migrate();

    const rows = queryAll<{ profile_id: string; hash: string }>(
      "SELECT profile_id, hash FROM profile_audio ORDER BY profile_id, hash",
    );
    closeDb();

    expect(rows).toEqual([
      { profile_id: "p-normal", hash: "hash-kick" },
      { profile_id: "p-normal", hash: "hash-snare" },
      { profile_id: "p-shares", hash: "hash-kick" },
    ]);
  });

  it("does not fail on a blob that will not parse", () => {
    // json_each over an unparseable blob yields no rows rather than raising,
    // so one bad profile skips itself instead of stopping the app booting.
    migrate();

    const version = queryOne<{ user_version: number }>("PRAGMA user_version");
    const indexed = queryAll<{ profile_id: string }>(
      "SELECT DISTINCT profile_id FROM profile_audio ORDER BY profile_id",
    ).map((row) => row.profile_id);
    closeDb();

    // At least 3, not exactly: later migrations append, and the point here is
    // that the backfill completed rather than throwing partway. On its own
    // that is barely more than "it did not throw", though — the chain runs to
    // head, so any migration at all satisfies it.
    expect(version?.user_version).toBeGreaterThanOrEqual(3);

    // This is the claim the test is named for: the three malformed blobs
    // skipped themselves, and the profiles either side of them were still
    // indexed. A migration that gave up at the first bad row would leave
    // `p-shares` — seeded after `p-broken`'s neighbours — out.
    expect(indexed).toEqual(["p-normal", "p-shares"]);
  });

  it("adds migration 5's added_by as null on every row it backfilled", () => {
    // The seed is at user_version 2, so this runs the whole chain to head —
    // which is the shape of the upgrade the deployed database will take. A
    // pre-existing row has no record of who attached the sound, and null is
    // the honest answer: profileMayServeHash falls back to the owner and
    // email-editor tests for those, exactly as before.
    migrate();

    const rows = queryAll<{ added_by: number | null }>(
      "SELECT added_by FROM profile_audio",
    );
    closeDb();

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.added_by === null)).toBe(true);
  });

  it("leaves the blobs themselves untouched", () => {
    migrate();

    const row = queryOne<{ data: string }>(
      "SELECT data FROM profiles WHERE id = ?",
      "p-broken",
    );
    closeDb();

    expect(row?.data).toBe("this is not json");
  });
});
