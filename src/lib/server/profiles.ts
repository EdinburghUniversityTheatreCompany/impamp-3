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
}

export function getProfileById(id: string): ProfileRow | undefined {
  return queryOne<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
}

export function createProfile(input: CreateProfileInput): ProfileRow {
  const id = randomUUID();
  const now = Date.now();

  execute(
    `INSERT INTO profiles (id, owner_id, name, data, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    id,
    input.ownerId,
    input.name,
    JSON.stringify(input.data),
    now,
    now,
  );

  return getProfileById(id)!;
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
  input: { name: string; data: unknown; expectedVersion: number },
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
      JSON.stringify(input.data),
      Date.now(),
      id,
    );

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
  return queryAll<ProfileSummary>(
    `SELECT p.id, p.name, p.version, p.updated_at AS updatedAt,
            CASE WHEN p.owner_id = ? THEN 'owner' ELSE s.role END AS access,
            owner.email AS ownerEmail
       FROM profiles p
       JOIN users owner ON owner.id = p.owner_id
       LEFT JOIN profile_shares s
         ON s.profile_id = p.id AND s.email = ?
      WHERE p.owner_id = ? OR s.id IS NOT NULL
      ORDER BY p.updated_at DESC`,
    userId,
    email,
    userId,
  );
}
