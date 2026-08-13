/**
 * Who may hold a server-sync account.
 *
 * The app is deployed on a public URL, so without a policy any Google account
 * that reaches it can sign in and store profiles. `IMPAMP_ALLOWED_EMAILS`
 * restricts that to named addresses and/or whole domains:
 *
 *   IMPAMP_ALLOWED_EMAILS="me@example.com,@bedlamtheatre.co.uk"
 *
 * Unset (the default) leaves sign-up open, which is the right choice for a
 * private or trusted-network deployment and the wrong one for a public host.
 *
 * This gate only governs *server sync*. Google Drive sync needs no account
 * here and is unaffected either way.
 */

import { normalizeEmail } from "./users";

/** Entries are either a full address or a `@domain` suffix. */
function allowedEntries(): string[] {
  const raw = process.env.IMPAMP_ALLOWED_EMAILS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isSignupAllowed(email: string): boolean {
  const entries = allowedEntries();
  // No policy configured — anyone who can sign in with Google may sync.
  if (entries.length === 0) return true;

  const normalized = normalizeEmail(email);
  return entries.some((entry) =>
    entry.startsWith("@") ? normalized.endsWith(entry) : normalized === entry,
  );
}
