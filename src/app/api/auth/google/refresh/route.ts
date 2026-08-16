import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  establishSession,
} from "@/lib/server/establishSession";
import { getSessionUser, SESSION_COOKIE } from "@/lib/server/session";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

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
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Google OAuth not configured on server" },
      { status: 500 },
    );
  }

  let refreshToken: string;
  try {
    const body = await request.json();
    refreshToken = body.refresh_token;
    if (!refreshToken) throw new Error("Missing refresh_token");
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    );

    const data = await response.json();

    if (!response.ok) {
      // Token revoked or invalid — the user needs to sign in again
      return NextResponse.json(
        {
          error: data.error_description || data.error || "Token refresh failed",
        },
        { status: 400 },
      );
    }

    const result = NextResponse.json({
      access_token: data.access_token,
      expires_in: data.expires_in,
    });

    // Only mint a session when there isn't a working one — this route runs
    // every time a token expires, and re-signing each time would pile up
    // session rows for no gain.
    const existing = getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!existing) {
      const session = await establishSession(data.access_token);
      if (session) attachSessionCookie(result, session);
    }

    return result;
  } catch {
    // Network failure — don't log the user out, let caller retry later
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
