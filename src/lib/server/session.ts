/**
 * Session cookies for server-backed sync.
 *
 * A session is a random bearer token handed to the browser in an HttpOnly
 * cookie. Only its SHA-256 hash is stored, so a database leak doesn't hand
 * anyone a working session.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { execute, queryOne, type UserRow } from "./db";
import { getUserById } from "./users";

export const SESSION_COOKIE = "impamp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a session for a user and return the raw token to put in the cookie. */
export function createSession(userId: number): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  execute(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    hashToken(token),
    userId,
    now,
    now + SESSION_TTL_MS,
  );

  // Opportunistic cleanup — sessions are only written at sign-in, so this
  // stays cheap without needing a scheduled job.
  execute("DELETE FROM sessions WHERE expires_at < ?", now);

  return token;
}

/** Resolve a raw session token to its user, or null if invalid or expired. */
export function getSessionUser(token: string | undefined): UserRow | null {
  if (!token) return null;

  const row = queryOne<{ user_id: number; expires_at: number }>(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
    hashToken(token),
  );

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return null;
  }

  return getUserById(row.user_id) ?? null;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  execute("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

/** Cookie attributes. Secure is dropped in development so http://localhost works. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** The signed-in user for the current request, or null. */
export async function getCurrentUser(): Promise<UserRow | null> {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value);
}

/**
 * Constant-time comparison for share tokens supplied in a URL, so a caller
 * can't learn a valid token from response timing.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
