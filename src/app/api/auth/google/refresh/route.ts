import { NextRequest, NextResponse } from "next/server";

/**
 * Refreshes a Google OAuth access token using a refresh token.
 * Uses the server-side client secret so it never reaches the browser.
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

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

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

    return NextResponse.json({
      access_token: data.access_token,
      expires_in: data.expires_in,
    });
  } catch {
    // Network failure — don't log the user out, let caller retry later
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
