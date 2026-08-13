/**
 * Profile sharing and access resolution.
 *
 * Two kinds of share exist:
 *   - **email** — an invited Google account, matched at sign-in time.
 *   - **link**  — a bearer token in the URL; whoever holds it gets the role,
 *     signed in or not. This is what makes anonymous view-only work.
 */

import { randomBytes } from "node:crypto";
import {
  execute,
  queryAll,
  queryOne,
  type Access,
  type Role,
  type ShareRow,
} from "./db";
import { normalizeEmail } from "./users";

export function listShares(profileId: string): ShareRow[] {
  return queryAll<ShareRow>(
    "SELECT * FROM profile_shares WHERE profile_id = ? ORDER BY created_at",
    profileId,
  );
}

export function getShareByLinkToken(token: string): ShareRow | undefined {
  return queryOne<ShareRow>(
    "SELECT * FROM profile_shares WHERE link_token = ?",
    token,
  );
}

/**
 * Invite an email address. Re-inviting an address already on the profile
 * updates its role rather than erroring, which is what the UI expects when
 * someone is promoted from viewer to editor.
 */
export function upsertEmailShare(
  profileId: string,
  email: string,
  role: Role,
  createdBy: number,
): ShareRow {
  const normalized = normalizeEmail(email);
  execute(
    `INSERT INTO profile_shares (profile_id, email, link_token, role, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, ?)
     -- profile_shares_email_idx is a partial index, so the upsert target has
     -- to repeat its WHERE clause for SQLite to match it.
     ON CONFLICT (profile_id, email) WHERE email IS NOT NULL
     DO UPDATE SET role = excluded.role`,
    profileId,
    normalized,
    role,
    createdBy,
    Date.now(),
  );

  return queryOne<ShareRow>(
    "SELECT * FROM profile_shares WHERE profile_id = ? AND email = ?",
    profileId,
    normalized,
  )!;
}

/**
 * Create a link share. Each call mints a fresh token, so revoking one link
 * never invalidates another.
 */
export function createLinkShare(
  profileId: string,
  role: Role,
  createdBy: number,
): ShareRow {
  const token = randomBytes(24).toString("base64url");
  const result = execute(
    `INSERT INTO profile_shares (profile_id, email, link_token, role, created_by, created_at)
     VALUES (?, NULL, ?, ?, ?, ?)`,
    profileId,
    token,
    role,
    createdBy,
    Date.now(),
  );

  return queryOne<ShareRow>(
    "SELECT * FROM profile_shares WHERE id = ?",
    Number(result.lastInsertRowid),
  )!;
}

/** Remove a share. Scoped by profile so an id from another profile can't be used. */
export function deleteShare(profileId: string, shareId: number): boolean {
  const result = execute(
    "DELETE FROM profile_shares WHERE id = ? AND profile_id = ?",
    shareId,
    profileId,
  );
  return result.changes > 0;
}

export interface AccessRequest {
  profileId: string;
  /** The signed-in user, if any. */
  user?: { id: number; email: string } | null;
  /** A link-share token supplied by the caller, if any. */
  linkToken?: string | null;
}

/** Ordering used to keep the strongest of several applicable grants. */
const ACCESS_RANK: Record<Access, number> = { viewer: 1, editor: 2, owner: 3 };

/**
 * Resolve what a caller may do with a profile, taking the strongest of every
 * grant that applies: ownership, an email invite, and a link token can all be
 * true at once (an owner opening their own share link, say).
 *
 * Returns `null` when the caller has no access at all — callers should answer
 * 404 rather than 403 for that, so profile IDs stay unenumerable.
 */
export function resolveAccess(request: AccessRequest): Access | null {
  const grants: Access[] = [];

  const profile = queryOne<{ owner_id: number }>(
    "SELECT owner_id FROM profiles WHERE id = ?",
    request.profileId,
  );
  if (!profile) return null;

  if (request.user && profile.owner_id === request.user.id) {
    grants.push("owner");
  }

  if (request.user) {
    const emailShare = queryOne<{ role: Role }>(
      "SELECT role FROM profile_shares WHERE profile_id = ? AND email = ?",
      request.profileId,
      normalizeEmail(request.user.email),
    );
    if (emailShare) grants.push(emailShare.role);
  }

  if (request.linkToken) {
    const linkShare = getShareByLinkToken(request.linkToken);
    // A token only grants access to the profile it was minted for.
    if (linkShare && linkShare.profile_id === request.profileId) {
      grants.push(linkShare.role);
    }
  }

  if (grants.length === 0) return null;
  return grants.reduce((best, grant) =>
    ACCESS_RANK[grant] > ACCESS_RANK[best] ? grant : best,
  );
}

export function canWrite(access: Access | null): boolean {
  return access === "owner" || access === "editor";
}
