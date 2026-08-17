/**
 * Server-side SQLite storage for server-backed profile sync.
 *
 * Uses Node's built-in `node:sqlite` (no native dependency to compile, no
 * extra image build tooling). The database file lives on a persistent volume
 * in production — see `IMPAMP_DB_PATH` and the Kamal `volumes:` entry.
 *
 * This module must only ever be imported from server code (route handlers and
 * their tests). Importing it from a client component would try to bundle
 * `node:sqlite` for the browser.
 */

import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "viewer" | "editor";
export type Access = "owner" | Role;

export interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  is_admin: number;
  can_upload_audio: number;
  /** NULL means "use the deployment-wide default". */
  audio_quota_bytes: number | null;
  created_at: number;
  updated_at: number;
}

export interface AudioObjectRow {
  hash: string;
  size_bytes: number;
  content_type: string;
  extension: string;
  created_at: number;
}

export interface AudioReferenceRow {
  id: number;
  user_id: number;
  hash: string;
  name: string;
  created_at: number;
}

export interface ProfileRow {
  id: string;
  owner_id: number;
  name: string;
  data: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface ShareRow {
  id: number;
  profile_id: string;
  email: string | null;
  link_token: string | null;
  role: Role;
  created_by: number;
  created_at: number;
}

/**
 * Schema migrations, applied in order. The array index + 1 is the resulting
 * `PRAGMA user_version`, so append only — never edit or reorder an existing
 * entry once it has run anywhere.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub       TEXT    NOT NULL UNIQUE,
    email            TEXT    NOT NULL UNIQUE,
    name             TEXT,
    picture          TEXT,
    is_admin         INTEGER NOT NULL DEFAULT 0,
    can_upload_audio INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user_idx ON sessions(user_id);
  CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

  CREATE TABLE profiles (
    id         TEXT    PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX profiles_owner_idx ON profiles(owner_id);

  CREATE TABLE profile_shares (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    email      TEXT,
    link_token TEXT    UNIQUE,
    role       TEXT    NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    -- A share addresses exactly one subject: an invited email or a link token.
    CHECK ((email IS NULL) <> (link_token IS NULL))
  );
  CREATE UNIQUE INDEX profile_shares_email_idx
    ON profile_shares(profile_id, email) WHERE email IS NOT NULL;
  CREATE INDEX profile_shares_profile_idx ON profile_shares(profile_id);
  `,

  // 2 — hosted audio (optional, gated on users.can_upload_audio)
  `
  -- One row per distinct blob, keyed by the SHA-256 of its bytes. Two people
  -- uploading the same sound share one object, and the bucket key is derived
  -- from the hash, so this table is the record of what exists in the bucket.
  CREATE TABLE audio_objects (
    hash         TEXT    PRIMARY KEY,
    size_bytes   INTEGER NOT NULL,
    content_type TEXT    NOT NULL,
    extension    TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
  );

  -- One row per user per object: who is holding a reference, and therefore
  -- who is charged for it. An object with no references left is deleted from
  -- the bucket, so a shared blob only disappears once nobody holds it.
  CREATE TABLE audio_references (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash       TEXT    NOT NULL REFERENCES audio_objects(hash) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX audio_references_user_hash_idx
    ON audio_references(user_id, hash);
  CREATE INDEX audio_references_hash_idx ON audio_references(hash);

  -- NULL means "use the deployment-wide default", so raising the default
  -- lifts everyone who has not been given a specific allowance.
  ALTER TABLE users ADD COLUMN audio_quota_bytes INTEGER;
  `,

  // 3 — which sounds each profile names, as rows rather than as JSON
  `
  -- "Does any profile still play this sound?" used to be answered by reading
  -- every profile blob in the deployment into memory and JSON.parse-ing each
  -- one, on a single DELETE request. node:sqlite is synchronous and Node is
  -- single-threaded, so with a few hundred profiles that stopped the whole
  -- process — every other user's request, every SSE heartbeat, the health
  -- check — for as long as it took.
  --
  -- The question is an existence check, so it gets an index. Rebuilt from the
  -- blob whenever a profile is written; the blob stays the source of truth.
  CREATE TABLE profile_audio (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    hash       TEXT NOT NULL,
    PRIMARY KEY (profile_id, hash)
  );
  CREATE INDEX profile_audio_hash_idx ON profile_audio(hash);

  -- Backfill from what is already stored. json_each over a blob that does not
  -- parse, or whose audioFiles is not an array, yields no rows rather than an
  -- error, so a malformed profile is skipped instead of failing the migration.
  INSERT OR IGNORE INTO profile_audio (profile_id, hash)
  SELECT p.id, json_extract(f.value, '$.hash')
    FROM profiles p, json_each(json_extract(p.data, '$.audioFiles')) f
   WHERE json_valid(p.data)
     AND json_type(p.data, '$.audioFiles') = 'array'
     AND json_extract(f.value, '$.hash') IS NOT NULL;
  `,

  // 4 — drop an index no query can use
  `
  -- Nothing filters or joins sessions on user_id: the only reads are by
  -- token_hash (session lookup) and by expires_at (the sweep). It cost a write
  -- on every sign-in and bought no read.
  --
  -- Migration 1 still creates it, deliberately: that entry has already run on
  -- the deployed database, and editing an applied migration would leave old
  -- and new databases with different schemas. Appending is the only way both
  -- end up in the same place.
  DROP INDEX IF EXISTS sessions_user_idx;
  `,

  // 5 — who put each sound on each profile
  `
  -- "Could this sound legitimately be on this profile?" was answered by
  -- re-deriving it from the *live* share table: the owner, or a current
  -- email-share editor. That is wrong twice. A link share has
  -- \`email IS NULL\` by the CHECK constraint in migration 1, so it never
  -- joined, and a sound added by a link-share editor was 404 for everyone
  -- including the owner. And reading live shares made the answer retroactive:
  -- revoking a share took away audio the departed collaborator had already
  -- contributed, silencing pads on the owner's own board.
  --
  -- A grant is a fact about the past, so it is recorded when the sound is
  -- attached rather than recomputed later. NULL for every row that predates
  -- this migration, and for a write by an anonymous link-share editor, who
  -- has no account to name; those fall back to the owner and email-editor
  -- tests exactly as before.
  --
  -- Deliberately no REFERENCES clause. SQLite allows one on ADD COLUMN only
  -- with a NULL default, and the value is only ever compared against
  -- audio_references.user_id — which cascades on user delete — so a stale id
  -- matches nothing rather than serving the wrong person.
  ALTER TABLE profile_audio ADD COLUMN added_by INTEGER;
  `,
];

let db: DatabaseSync | null = null;

/** Resolve the database file path. `:memory:` is honoured for tests. */
function resolveDbPath(): string {
  return process.env.IMPAMP_DB_PATH || "./data/impamp.db";
}

function applyMigrations(database: DatabaseSync): void {
  const { user_version: current } = database
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };

  for (let version = current; version < MIGRATIONS.length; version++) {
    database.exec("BEGIN");
    try {
      database.exec(MIGRATIONS[version]);
      // PRAGMA does not accept bound parameters, and `version + 1` is a number
      // we produced ourselves, so interpolation is safe here.
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Open (once) and return the shared database handle.
 * Safe to call from every request — the handle is cached per process.
 */
export function getDb(): DatabaseSync {
  if (db) return db;

  const path = resolveDbPath();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new DatabaseSync(path);
  // WAL keeps readers from blocking on the writer; NORMAL is the standard
  // durability trade-off to pair with it.
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  database.exec("PRAGMA foreign_keys = ON");
  // Wait rather than fail immediately when another request holds the write lock.
  database.exec("PRAGMA busy_timeout = 5000");

  applyMigrations(database);

  db = database;
  return db;
}

/**
 * Close and forget the shared handle. Tests use this to start from a clean
 * database; production never calls it.
 */
export function closeDb(): void {
  // node:sqlite finalizes a connection's statements when it closes, so the
  // cache only has to forget them — holding them across a `closeDb` would hand
  // the next database statements belonging to the old one.
  statementCache.clear();
  db?.close();
  db = null;
}

/**
 * Prepared statements, keyed by their SQL.
 *
 * `prepare()` re-parses and re-plans the query every time, and the statement
 * objects were left to the garbage collector rather than finalized. Every SQL
 * string in this codebase is a static literal, so the cache can be keyed on the
 * text itself and can never grow beyond the number of distinct queries.
 * Planning is not free — the profile listing joins three tables — and this runs
 * on the request-serving thread.
 */
const statementCache = new Map<string, StatementSync>();

function prepared(sql: string): StatementSync {
  const database = getDb();
  let statement = statementCache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    statementCache.set(sql, statement);
  }
  return statement;
}

/**
 * node:sqlite hands back loosely typed rows (`Record<string, SQLOutputValue>`).
 * These helpers put the narrowing in one place instead of a cast per query —
 * the row shape is still asserted, not checked, so the type argument must
 * match what the SQL actually selects.
 */
export function queryOne<T>(
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return prepared(sql).get(...params) as T | undefined;
}

export function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return prepared(sql).all(...params) as T[];
}

export function execute(sql: string, ...params: SQLInputValue[]) {
  return prepared(sql).run(...params);
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
