/**
 * The half of both Google token routes that is the same in both.
 *
 * `/api/auth/google/exchange` and `/api/auth/google/refresh` differ in exactly
 * three things: which body field carries the credential, which `grant_type`
 * Google is told, and what the failure is called. Everything else — reading the
 * server-side client secret, bounding and parsing the body, posting to Google's
 * token endpoint, turning a rejection into a 400 and an unreachable Google into
 * a 503 — was written out twice, and the two copies had already drifted in
 * wording while meaning the same thing.
 *
 * Both routes are reachable without a session, so the body bound matters here
 * more than anywhere else in the app: see `lib/server/requestBody`.
 *
 * @module lib/server/googleTokenRequest
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { parseJsonBody } from "./requestBody";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** What Google answers with. Loosely typed, because Google decides. */
export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
}

export interface GoogleGrant {
  /** The body field carrying the credential — `code` or `refresh_token`. */
  field: string;
  /** The OAuth grant type that field belongs to. */
  grantType: string;
  /** Anything else this grant needs in the form body. */
  extraParams?: Record<string, string>;
  /** What to call it when Google says no. */
  failureMessage: string;
}

/**
 * Trade a credential for tokens, or produce the response to send instead.
 *
 * A rejection from Google is a 400 rather than a 5xx on purpose: the credential
 * is expired, revoked or already spent, and the client's job is to send the
 * user back through sign-in. An unreachable Google is a 503, which the client
 * treats as "retry later" rather than "you are signed out" — losing a session
 * because a network hiccup is a much worse outcome than a delay.
 *
 * @param request - The incoming route request
 * @param grant - What distinguishes this route from the other one
 * @returns Google's token response, or a 400/413/500/503 to return as-is
 */
export async function requestGoogleToken(
  request: NextRequest,
  grant: GoogleGrant,
): Promise<GoogleTokenResponse | NextResponse> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Google OAuth not configured on server" },
      { status: 500 },
    );
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (body instanceof NextResponse) return body;

  const credential = body[grant.field];
  if (typeof credential !== "string" || !credential) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    const response = await fetchWithTimeout(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        [grant.field]: credential,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: grant.grantType,
        ...grant.extraParams,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error: data.error_description || data.error || grant.failureMessage,
        },
        { status: 400 },
      );
    }

    return data as GoogleTokenResponse;
  } catch {
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
