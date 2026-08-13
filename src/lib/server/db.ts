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

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
  db?.close();
  db = null;
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
  return getDb()
    .prepare(sql)
    .get(...params) as T | undefined;
}

export function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...params) as T[];
}

export function execute(sql: string, ...params: SQLInputValue[]) {
  return getDb()
    .prepare(sql)
    .run(...params);
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
