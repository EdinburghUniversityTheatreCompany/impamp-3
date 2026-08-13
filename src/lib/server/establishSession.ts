/**
 * Turns a freshly obtained Google access token into a server session.
 *
 * Shared by the OAuth code-exchange and token-refresh routes so that a user
 * who signs in for Drive sync also gets a server-sync session, without a
 * second consent prompt or a second round trip from the browser.
 */

import type { NextResponse } from "next/server";
import { fetchGoogleIdentity } from "./googleIdentity";
import { isSignupAllowed } from "./signupPolicy";
import { upsertUserFromGoogle, toPublicUser, type PublicUser } from "./users";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "./session";

export interface EstablishedSession {
  user: PublicUser;
  token: string;
}

/**
 * Sign in whoever owns `accessToken`, creating the user on first sight.
 *
 * Never throws: server sync is an addition to Drive sync, so a failure here
 * (Google unreachable, database not writable) must leave the caller's own
 * response intact rather than breaking sign-in.
 *
 * @returns the user and session token, or null if no session could be made.
 */
export async function establishSession(
  accessToken: string,
): Promise<EstablishedSession | null> {
  try {
    const identity = await fetchGoogleIdentity(accessToken);
    if (!identity) return null;

    if (!isSignupAllowed(identity.email)) {
      console.warn(
        `Refusing a server-sync session for ${identity.email}: not in IMPAMP_ALLOWED_EMAILS`,
      );
      return null;
    }

    const user = upsertUserFromGoogle(identity);
    return { user: toPublicUser(user), token: createSession(user.id) };
  } catch (error) {
    console.error("Could not establish a server-sync session:", error);
    return null;
  }
}

/** Write the session cookie for an established session onto a response. */
export function attachSessionCookie(
  response: NextResponse,
  session: EstablishedSession,
): void {
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions());
}
