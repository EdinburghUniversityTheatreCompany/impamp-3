/**
 * Resolves a Google access token to the account behind it.
 *
 * This runs server-side against Google's userinfo endpoint using a token we
 * obtained ourselves (via the code exchange or refresh route, with our own
 * client secret). Because the response comes straight from Google over TLS in
 * reply to our own request, there is nothing further to verify — unlike an
 * ID token handed to us by a browser, which would need signature checks.
 */

import type { GoogleIdentity } from "./users";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

interface GoogleUserInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * @returns the identity, or null if the token can't be resolved to a verified
 * email — callers treat that as "no server session", never as a hard failure,
 * so Drive-only sign-in keeps working regardless.
 */
export async function fetchGoogleIdentity(
  accessToken: string,
): Promise<GoogleIdentity | null> {
  try {
    const response = await fetchWithTimeout(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      console.warn(
        `Google userinfo lookup failed with ${response.status} — no server session created`,
      );
      return null;
    }

    const info = (await response.json()) as GoogleUserInfoResponse;
    if (!info.sub || !info.email) return null;
    // An unverified email must never be usable to claim an email share.
    if (info.email_verified === false) {
      console.warn("Google account email is unverified — no server session");
      return null;
    }

    return {
      sub: info.sub,
      email: info.email,
      name: info.name ?? null,
      picture: info.picture ?? null,
    };
  } catch (error) {
    console.warn("Could not reach Google userinfo endpoint:", error);
    return null;
  }
}
