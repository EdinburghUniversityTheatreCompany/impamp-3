/**
 * User records for server-backed sync.
 *
 * Identity comes from Google: the OAuth code exchange happens server-side, so
 * the profile we read back from Google's userinfo endpoint is trusted without
 * further verification (we asked Google directly, over TLS, with our own
 * client secret).
 */

import { getDb, transaction, type UserRow } from "./db";

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
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
}

export function getUserByEmail(email: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(normalizeEmail(email)) as UserRow | undefined;
}

export function getUserByGoogleSub(sub: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE google_sub = ?")
    .get(sub) as UserRow | undefined;
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
    const db = getDb();
    const existing = getUserByGoogleSub(identity.sub);

    if (existing) {
      db.prepare(
        `UPDATE users SET email = ?, name = ?, picture = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        email,
        identity.name ?? null,
        identity.picture ?? null,
        now,
        existing.id,
      );
      return getUserById(existing.id)!;
    }

    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as {
      count: number;
    };
    const isAdmin = count === 0 ? 1 : 0;

    const result = db
      .prepare(
        `INSERT INTO users
           (google_sub, email, name, picture, is_admin, can_upload_audio, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
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
