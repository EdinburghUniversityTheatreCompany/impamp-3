import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  establishSession,
} from "@/lib/server/establishSession";
import { getSessionUser, SESSION_COOKIE } from "@/lib/server/session";
import { requestGoogleToken } from "@/lib/server/googleTokenRequest";

/**
 * Refreshes a Google OAuth access token using a refresh token.
 * Uses the server-side client secret so it never reaches the browser.
 *
 * Doubles as the recovery path for the server-sync session: a browser whose
 * session cookie has expired (or that never had one, having signed in before
 * server sync existed) gets a fresh one here, since the client keeps calling
 * this route for as long as its Google refresh token is good.
 *
 * POST /api/auth/google/refresh
 * Body: { refresh_token: string }
 * Returns: { access_token, expires_in }
 */
export async function POST(request: NextRequest) {
  // Shared with the exchange route — see `lib/server/googleTokenRequest`. A
  // revoked or invalid refresh token comes back as a 400 and the user signs in
  // again; an unreachable Google comes back as a 503 and they do not, which is
  // the distinction worth keeping on a route that runs on every token expiry.
  const tokens = await requestGoogleToken(request, {
    field: "refresh_token",
    grantType: "refresh_token",
    failureMessage: "Token refresh failed",
  });
  if (tokens instanceof NextResponse) return tokens;

  const result = NextResponse.json({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  });

  // Only mint a session when there isn't a working one — this route runs
  // every time a token expires, and re-signing each time would pile up
  // session rows for no gain.
  const existing = getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  if (!existing) {
    const session = await establishSession(tokens.access_token);
    if (session) attachSessionCookie(result, session);
  }

  return result;
}
