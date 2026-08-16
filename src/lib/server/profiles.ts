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
 */
function reindexProfileAudio(profileId: string, data: unknown): void {
  execute("DELETE FROM profile_audio WHERE profile_id = ?", profileId);
  for (const hash of hashesNamedBy(data)) {
    execute(
      "INSERT OR IGNORE INTO profile_audio (profile_id, hash) VALUES (?, ?)",
      profileId,
      hash,
    );
  }
}

export function createProfile(input: CreateProfileInput): ProfileRow {
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
    reindexProfileAudio(id, input.data);

    return getProfileById(id)!;
  });
}

export type UpdateProfileResult =
  | { status: "ok"; profile: ProfileRow }
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
  },
): UpdateProfileResult {
  return transaction(() => {
    const current = getProfileById(id);
    if (!current) return { status: "not_found" as const };

    if (current.version !== input.expectedVersion) {
      return { status: "conflict" as const, profile: current };
    }

    execute(
      `UPDATE profiles
          SET name = ?, data = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
      input.name,
      // Serialised before the transaction opened where the caller had it: this
      // used to run under BEGIN IMMEDIATE, holding the write lock for the
      // length of an 8 MB stringify.
      input.serialisedData ?? JSON.stringify(input.data),
      Date.now(),
      id,
    );
    reindexProfileAudio(id, input.data);

    return { status: "ok" as const, profile: getProfileById(id)! };
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
