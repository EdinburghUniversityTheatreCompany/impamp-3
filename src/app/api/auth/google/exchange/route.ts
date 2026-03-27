import { NextRequest, NextResponse } from "next/server";

/**
 * Exchanges a Google OAuth authorization code for access and refresh tokens.
 * Uses the server-side client secret so it never reaches the browser.
 *
 * POST /api/auth/google/exchange
 * Body: { code: string }
 * Returns: { access_token, refresh_token, expires_in }
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

  let code: string;
  try {
    const body = await request.json();
    code = body.code;
    if (!code) throw new Error("Missing code");
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    const params = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "postmessage",
      grant_type: "authorization_code",
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    const data = await response.json();

    if (!response.ok) {
      // Invalid/expired code — client must re-initiate login
      return NextResponse.json(
        {
          error:
            data.error_description || data.error || "Token exchange failed",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_in: data.expires_in,
    });
  } catch {
    // Network failure (e.g. server is offline) — don't log the user out
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
