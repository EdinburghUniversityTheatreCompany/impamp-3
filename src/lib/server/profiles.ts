/**
 * Server-stored profiles.
 *
 * A profile row holds the same `ProfileSyncData` JSON the Drive sync writes,
 * plus a monotonic `version` used for optimistic concurrency. Audio is *not*
 * stored here: the blob carries content hashes and Drive file IDs, and
 * collaborators fetch the bytes from Drive exactly as they do today.
 */

import { randomUUID } from "node:crypto";
import {
  execute,
  queryAll,
  queryOne,
  transaction,
  type ProfileRow,
} from "./db";

export interface CreateProfileInput {
  ownerId: number;
  name: string;
  data: unknown;
  /** `data` already serialised, when the caller has it (see ProfileWriteBody). */
  serialisedData?: string;
}

export function getProfileById(id: string): ProfileRow | undefined {
  return queryOne<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
}

/** A profile row without its blob. */
export type ProfileMeta = Omit<ProfileRow, "data">;

/**
 * Everything about a profile except the thing that makes it expensive.
 *
 * `getProfileById` is `SELECT *`, which reads the `data` column — up to
 * MAX_PROFILE_BODY_BYTES — off disk through SQLite's overflow chain and
 * materialises it as a UTF-16 string, synchronously. Several callers need only
 * `version` or `owner_id`: the 304 branch of GET, DELETE, and the SSE connect
 * and 25-second heartbeat, which runs once per open stream per tab.
 */
export function getProfileMeta(id: string): ProfileMeta | undefined {
  return queryOne<ProfileMeta>(
    `SELECT id, owner_id, name, version, created_at, updated_at
       FROM profiles WHERE id = ?`,
    id,
  );
}

/**
 * The content hashes a profile blob names, deduplicated.
 *
 * Tolerant on purpose: the blob is written by clients of varying ages, and a
 * shape this does not recognise should index nothing rather than throw on a
 * write path.
 */
function hashesNamedBy(data: unknown): string[] {
  const files = (data as { audioFiles?: unknown } | null)?.audioFiles;
  if (!Array.isArray(files)) return [];

  const hashes = new Set<string>();
  for (const file of files) {
    const hash = (file as { hash?: unknown } | null)?.hash;
    if (typeof hash === "string" && hash.length > 0) hashes.add(hash);
  }
  return [...hashes];
}

/**
 * Rewrites the `profile_audio` rows for one profile.
 *
 * Called inside the same transaction as the blob write, so the index cannot
 * disagree with the blob it describes.
 *
 * Rows that survive the write are left alone rather than deleted and
 * re-inserted, because `added_by` records who first put a sound on this
 * profile and that must not drift. Re-inserting would re-attribute an
 * editor's sound to the owner the next time the owner saved, and the owner
 * holds no reference to it — which is precisely the 404 this column exists to
 * stop.
 *
 * @param writerId - The account publishing this write, or null for an
 *   anonymous link-share editor, who has none to record.
 */
function reindexProfileAudio(
  profileId: string,
  data: unknown,
  writerId: number | null,
): void {
  const wanted = new Set(hashesNamedBy(data));
  const existing = new Set(
    queryAll<{ hash: string }>(
      "SELECT hash FROM profile_audio WHERE profile_id = ?",
      profileId,
    ).map((row) => row.hash),
  );

  for (const hash of existing) {
    if (!wanted.has(hash)) {
      execute(
        "DELETE FROM profile_audio WHERE profile_id = ? AND hash = ?",
        profileId,
        hash,
      );
    }
  }

  // Only the ones that are not already there. The rows were previously
  // re-inserted unconditionally — `INSERT OR IGNORE` makes that correct but
  // not free: it is a statement per sound per save, inside `BEGIN IMMEDIATE`,
  // for a write that in the overwhelmingly common case changes nothing at all
  // (a pad moved, a bank renamed, the same sounds). The read that decides is
  // the one above, which had to happen anyway.
  for (const hash of wanted) {
    if (existing.has(hash)) continue;
    execute(
      "INSERT OR IGNORE INTO profile_audio (profile_id, hash, added_by) VALUES (?, ?, ?)",
      profileId,
      hash,
      writerId,
    );
  }
}

/**
 * Whether this profile names this sound, answered from the index.
 *
 * Hits `profile_audio`'s primary key. The alternative — `SELECT *` and a
 * `JSON.parse` of up to 8 MB — is what the hosted-audio download did for a
 * membership question, once per sound per collaborator per session,
 * synchronously, on the thread serving everyone else. Migration 3 added this
 * table for exactly this class of question and backfilled it, and every write
 * rebuilds it inside the same transaction as the blob, so it cannot disagree
 * with what it describes.
 */
export function profileNamesHash(profileId: string, hash: string): boolean {
  return (
    queryOne<{ one: number }>(
      "SELECT 1 AS one FROM profile_audio WHERE profile_id = ? AND hash = ?",
      profileId,
      hash,
    ) !== undefined
  );
}

/**
 * Store a new profile, and describe it without reading it back.
 *
 * `ProfileMeta` rather than `ProfileRow` deliberately: every field below was
 * just written by this function, so a `SELECT *` to recover them would read
 * the blob straight back off disk — up to MAX_PROFILE_BODY_BYTES, through the
 * overflow chain, into a UTF-16 string — to learn a version number this code
 * chose. A caller that genuinely wants the blob asks `getProfileById` for it.
 */
export function createProfile(input: CreateProfileInput): ProfileMeta {
  const id = randomUUID();
  const now = Date.now();

  return transaction(() => {
    execute(
      `INSERT INTO profiles (id, owner_id, name, data, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      id,
      input.ownerId,
      input.name,
      input.serialisedData ?? JSON.stringify(input.data),
      now,
      now,
    );
    reindexProfileAudio(id, input.data, input.ownerId);

    return {
      id,
      owner_id: input.ownerId,
      name: input.name,
      version: 1,
      created_at: now,
      updated_at: now,
    };
  });
}

export type UpdateProfileResult =
  /** No blob: an accepted write already knows everything about its own result. */
  | { status: "ok"; profile: ProfileMeta }
  /** With the blob, which is the whole point of a 409 here. */
  | { status: "conflict"; profile: ProfileRow }
  | { status: "not_found" };

/**
 * Write new profile data, but only if the caller was working from the current
 * version. A stale `expectedVersion` returns `conflict` along with the current
 * row so the caller can merge and retry.
 *
 * There is deliberately no "overwrite regardless" mode: an unconditional write
 * is the silent-clobber failure this whole backend exists to remove. A client
 * establishing a profile for the first time calls `createProfile` instead.
 */
export function updateProfile(
  id: string,
  input: {
    name: string;
    data: unknown;
    expectedVersion: number;
    serialisedData?: string;
    /** Who is publishing, so profile_audio can record it. See SV4. */
    writerId?: number | null;
  },
): UpdateProfileResult {
  return transaction(() => {
    // Meta, not the row: the only thing the accept/reject decision needs is
    // the version. Reading the blob to find it meant a full-body read under
    // `BEGIN IMMEDIATE` — holding the single instance's write lock across it —
    // for a write whose whole job is to replace that blob.
    const current = getProfileMeta(id);
    if (!current) return { status: "not_found" as const };

    if (current.version !== input.expectedVersion) {
      // Now the blob is worth reading, because handing it back is what lets
      // the caller merge and retry without another round trip.
      return { status: "conflict" as const, profile: getProfileById(id)! };
    }

    const updatedAt = Date.now();
    execute(
      `UPDATE profiles
          SET name = ?, data = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
      input.name,
      // Serialised before the transaction opened where the caller had it: this
      // used to run under BEGIN IMMEDIATE, holding the write lock for the
      // length of an 8 MB stringify.
      input.serialisedData ?? JSON.stringify(input.data),
      updatedAt,
      id,
    );
    reindexProfileAudio(id, input.data, input.writerId ?? null);

    // Composed from what the UPDATE above just set, rather than read back.
    // That was the third full-body read of one PUT, and the second one taken
    // while holding the write lock — to recover a name, a timestamp and a
    // version this transaction had itself decided.
    return {
      status: "ok" as const,
      profile: {
        ...current,
        name: input.name,
        version: current.version + 1,
        updated_at: updatedAt,
      },
    };
  });
}

export function deleteProfile(id: string): boolean {
  return execute("DELETE FROM profiles WHERE id = ?", id).changes > 0;
}

export interface ProfileSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  access: "owner" | "editor" | "viewer";
  ownerEmail: string;
}

/**
 * Every profile the user can reach: the ones they own, plus the ones shared
 * with their email address. Link-token shares are deliberately excluded —
 * holding a link grants access to that one profile, not a listing.
 */
export function listProfilesForUser(
  userId: number,
  email: string,
): ProfileSummary[] {
  // Two indexed lookups rather than one scan.
  //
  // The single query constrained the LEFT JOIN'd table in its WHERE
  // (`p.owner_id = ? OR s.id IS NOT NULL`), which stops SQLite using
  // `profiles_owner_idx` for either branch: `profiles` had to be the outer
  // loop and was read in full, every row's overflow chain walked because
  // `version` and `updated_at` sit *after* the 8 MB `data` column. On every
  // client mount.
  const owned = queryAll<ProfileSummary>(
    `SELECT p.id, p.name, p.version, p.updated_at AS updatedAt,
            'owner' AS access, owner.email AS ownerEmail
       FROM profiles p
       JOIN users owner ON owner.id = p.owner_id
      WHERE p.owner_id = ?`,
    userId,
  );

  const shared = queryAll<ProfileSummary>(
    `SELECT p.id, p.name, p.version, p.updated_at AS updatedAt,
            s.role AS access, owner.email AS ownerEmail
       FROM profile_shares s
       JOIN profiles p ON p.id = s.profile_id
       JOIN users owner ON owner.id = p.owner_id
      WHERE s.email = ? AND p.owner_id <> ?`,
    email,
    userId,
  );

  // Sorted here rather than by SQLite: `updated_at` is unindexed, so ORDER BY
  // meant a temp B-tree over the whole result anyway.
  return [...owned, ...shared].sort((a, b) => b.updatedAt - a.updatedAt);
}
