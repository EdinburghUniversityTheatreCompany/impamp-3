import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  establishSession,
} from "@/lib/server/establishSession";
import { requestGoogleToken } from "@/lib/server/googleTokenRequest";

/**
 * Exchanges a Google OAuth authorization code for access and refresh tokens.
 * Uses the server-side client secret so it never reaches the browser.
 *
 * Also establishes a server-sync session cookie for the same account, so a
 * single sign-in covers both Drive sync and server sync. Failing to do so is
 * not an error: the response still carries the Drive tokens.
 *
 * POST /api/auth/google/exchange
 * Body: { code: string }
 * Returns: { access_token, refresh_token, expires_in, user }
 */
export async function POST(request: NextRequest) {
  // Reading the client secret, bounding the body and talking to Google are all
  // shared with the refresh route — see `lib/server/googleTokenRequest`. An
  // expired or already-spent code comes back from there as a 400, which is the
  // client's cue to send the user through sign-in again.
  const tokens = await requestGoogleToken(request, {
    field: "code",
    grantType: "authorization_code",
    extraParams: { redirect_uri: "postmessage" },
    failureMessage: "Token exchange failed",
  });
  if (tokens instanceof NextResponse) return tokens;

  const session = await establishSession(tokens.access_token);

  const result = NextResponse.json({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_in: tokens.expires_in,
    user: session?.user ?? null,
  });
  if (session) attachSessionCookie(result, session);
  return result;
}
