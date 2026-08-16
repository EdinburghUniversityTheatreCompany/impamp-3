/**
 * User records for server-backed sync.
 *
 * Identity comes from Google: the OAuth code exchange happens server-side, so
 * the profile we read back from Google's userinfo endpoint is trusted without
 * further verification (we asked Google directly, over TLS, with our own
 * client secret).
 */

import { execute, queryOne, transaction, type UserRow } from "./db";

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string | null;
  picture?: string | null;
}

/** Emails are compared case-insensitively; store them folded. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getUserById(id: number): UserRow | undefined {
  return queryOne<UserRow>("SELECT * FROM users WHERE id = ?", id);
}

export function getUserByEmail(email: string): UserRow | undefined {
  return queryOne<UserRow>(
    "SELECT * FROM users WHERE email = ?",
    normalizeEmail(email),
  );
}

function getUserByGoogleSub(sub: string): UserRow | undefined {
  return queryOne<UserRow>("SELECT * FROM users WHERE google_sub = ?", sub);
}

/**
 * Create or refresh the user behind a Google identity.
 *
 * The very first user to sign in becomes an admin — this instance is
 * self-hosted by the person deploying it, so bootstrapping from the first
 * sign-in avoids shipping a credential. Every later user starts unprivileged.
 *
 * Matching is by `google_sub` (stable) rather than email (users can change
 * theirs); a changed email is written back onto the existing row.
 */
export function upsertUserFromGoogle(identity: GoogleIdentity): UserRow {
  const email = normalizeEmail(identity.email);
  const now = Date.now();

  return transaction(() => {
    const existing = getUserByGoogleSub(identity.sub);

    if (existing) {
      execute(
        `UPDATE users SET email = ?, name = ?, picture = ?, updated_at = ?
          WHERE id = ?`,
        email,
        identity.name ?? null,
        identity.picture ?? null,
        now,
        existing.id,
      );
      return getUserById(existing.id)!;
    }

    // The same address can come back under a new Google `sub` — a recycled
    // Workspace account, or a person re-created after deletion. Inserting
    // then threw UNIQUE on users.email, `establishSession` swallowed it, and
    // that account silently never got server sync again, with only a server
    // log to say why. The address is the identity people actually recognise,
    // so the row moves to the new sub.
    const byEmail = queryOne<UserRow>(
      "SELECT * FROM users WHERE email = ?",
      email,
    );
    if (byEmail) {
      // The row moves to the new sub — but `is_admin` does not come with it.
      //
      // Taking over by address is the right call for a recycled Workspace
      // account, and it is also the whole of what an attacker needs: whoever
      // ends up holding an address inherits the account. Inheriting *ownership
      // of the deployment* on top of that is a different order of thing, and
      // the first-user-is-admin rule means the address most likely to be
      // recycled is the one that has it. Re-granting it is one UPDATE by an
      // existing admin.
      execute(
        `UPDATE users SET google_sub = ?, name = ?, picture = ?,
                          is_admin = 0, updated_at = ?
          WHERE id = ?`,
        identity.sub,
        identity.name ?? null,
        identity.picture ?? null,
        now,
        byEmail.id,
      );
      return getUserById(byEmail.id)!;
    }

    // "Is this the first user?", not "how many are there?". COUNT(*) walks
    // the whole table to answer a question `LIMIT 1` answers in one row, and
    // it runs inside the sign-in write transaction.
    const anyUser = queryOne<{ one: number }>(
      "SELECT 1 AS one FROM users LIMIT 1",
    );
    const isAdmin = anyUser === undefined ? 1 : 0;

    const result = execute(
      `INSERT INTO users
         (google_sub, email, name, picture, is_admin, can_upload_audio, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      identity.sub,
      email,
      identity.name ?? null,
      identity.picture ?? null,
      isAdmin,
      now,
      now,
    );

    return getUserById(Number(result.lastInsertRowid))!;
  });
}

/**
 * Set who may host audio and how much they get. Both fields are optional:
 * only what is passed changes, so approving a user does not silently reset an
 * allowance an admin set earlier.
 *
 * Returns the updated row, or undefined when there is no such user.
 */
export function setAudioPermissions(
  userId: number,
  {
    canUploadAudio,
    audioQuotaBytes,
  }: {
    canUploadAudio?: boolean;
    /** `null` puts the user back on the deployment default. */
    audioQuotaBytes?: number | null;
  },
): UserRow | undefined {
  if (!getUserById(userId)) return undefined;

  if (canUploadAudio !== undefined) {
    execute(
      "UPDATE users SET can_upload_audio = ?, updated_at = ? WHERE id = ?",
      canUploadAudio ? 1 : 0,
      Date.now(),
      userId,
    );
  }

  if (audioQuotaBytes !== undefined) {
    execute(
      "UPDATE users SET audio_quota_bytes = ?, updated_at = ? WHERE id = ?",
      audioQuotaBytes,
      Date.now(),
      userId,
    );
  }

  return getUserById(userId);
}

/** Shape returned to clients — never leaks internal columns wholesale. */
export interface PublicUser {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  isAdmin: boolean;
  canUploadAudio: boolean;
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    isAdmin: user.is_admin === 1,
    canUploadAudio: user.can_upload_audio === 1,
  };
}
