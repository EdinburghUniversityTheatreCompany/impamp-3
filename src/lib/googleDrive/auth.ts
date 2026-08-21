/**
 * Authentication handling for Google Drive integration
 * Manages token validation, refresh, and authentication state
 */

import { isTokenValid } from "./utils";
import { TokenInfo } from "./types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

/**
 * Validates the authentication state
 * @param tokenInfo The current token information
 * @returns Boolean indicating whether auth is valid
 */
export const validateAuthState = (tokenInfo: TokenInfo | null): boolean => {
  if (!tokenInfo) return false;

  return isTokenValid(tokenInfo.accessToken, tokenInfo.expiresAt);
};

/**
 * Attempts to refresh an expired access token via the server-side API route.
 * Using a server-side route keeps the client secret out of the browser.
 * Returns null on network failure (offline) so callers can retry later
 * without marking the user as needing re-authentication.
 * @param refreshToken The refresh token to use
 * @returns New token info, or null if refresh failed or is temporarily unavailable
 */
export const refreshAccessToken = async (
  refreshToken: string | null,
): Promise<TokenInfo | null> => {
  if (!refreshToken) return null;

  try {
    console.log("Refreshing access token via server-side route...");

    const response = await fetchWithTimeout("/api/auth/google/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    const data = await response.json();

    if (response.status === 503) {
      // Network failure — treat as temporary, don't invalidate auth
      console.warn("Token refresh deferred: server could not reach Google.");
      return null;
    }

    if (!response.ok) {
      console.error("Token refresh failed:", data);
      throw new Error(data.error || "Token refresh failed");
    }

    // Calculate token expiration time (expires_in is in seconds)
    const expiresAt = Date.now() + data.expires_in * 1000;

    return {
      accessToken: data.access_token,
      refreshToken: refreshToken, // Refresh token typically doesn't change
      expiresAt: expiresAt,
    };
  } catch (error) {
    console.error("Error refreshing access token:", error);
    return null;
  }
};

/**
 * Checks token validity and attempts to refresh if necessary
 * @param tokenInfo The current token information
 * @returns Object with validity status and optionally refreshed token info
 */
export const checkAndRefreshAuth = async (
  tokenInfo: TokenInfo | null,
): Promise<{ isValid: boolean; refreshedTokenInfo: TokenInfo | null }> => {
  // If no token info, can't validate
  if (!tokenInfo) {
    return { isValid: false, refreshedTokenInfo: null };
  }

  // If current token is valid, return it as is
  if (isTokenValid(tokenInfo.accessToken, tokenInfo.expiresAt)) {
    return { isValid: true, refreshedTokenInfo: null };
  }

  // Token is expired, try to refresh
  const refreshedTokenInfo = await refreshAccessToken(tokenInfo.refreshToken);

  if (refreshedTokenInfo) {
    // Successfully refreshed
    return { isValid: true, refreshedTokenInfo };
  } else {
    // Refresh failed
    return { isValid: false, refreshedTokenInfo: null };
  }
};

/**
 * Formats an authentication error message
 * @param error The error object or message
 * @returns A user-friendly error message
 */
export const formatAuthError = (error: unknown): string => {
  if (error instanceof Error) {
    return `Authentication error: ${error.message}`;
  }
  if (typeof error === "string") {
    return `Authentication error: ${error}`;
  }
  return "An unknown authentication error occurred";
};

/**
 * Handles a 401 Unauthorized response by checking if token refresh is needed
 * @param status The HTTP status code
 * @param tokenInfo The current token information
 * @returns Boolean indicating whether a refresh attempt should be made
 */
export const shouldAttemptTokenRefresh = (
  status: number,
  tokenInfo: TokenInfo | null,
): boolean => {
  // Only attempt refresh if we have a 401 status and a refresh token
  if (status !== 401) return false;
  if (!tokenInfo?.refreshToken) return false;

  return true;
};

/**
 * The one refresh in flight, whoever asked for it, and the newest token it
 * produced.
 *
 * A sync captures its `TokenInfo` once and threads that object through every
 * Drive call it makes. When the token expires part-way through, each call gets
 * its own 401 — and each 401 handler used to call `checkAndRefreshAuth`
 * itself, so a sync uploading twenty sounds could fire twenty
 * `POST /api/auth/google/refresh` requests. Worse, none of them helped the
 * next one: the sync's local `tokenInfo` is never rewritten, so a call made
 * *after* a successful refresh still presented the dead token and refreshed
 * all over again, and Google issued a fresh access token every time.
 *
 * `useGoogleDriveSync` already had this dedupe for its five-minute validation
 * poll. It lived in the hook, which is exactly one of the five places that
 * refresh; here it covers all of them.
 */
let refreshInFlight: Promise<{
  isValid: boolean;
  refreshedTokenInfo: TokenInfo | null;
}> | null = null;
let latestRefreshed: TokenInfo | null = null;

/**
 * `checkAndRefreshAuth`, but a caller holding a token someone else has already
 * replaced is handed the replacement instead of asking Google again.
 *
 * The in-flight promise coalesces callers that race; `latestRefreshed` covers
 * the ones that arrive afterwards still carrying the token they captured
 * before the sync started. Both are needed — a sequential sync loop never
 * races, and it was the worst offender.
 */
export const sharedCheckAndRefresh = async (
  tokenInfo: TokenInfo | null,
): Promise<{ isValid: boolean; refreshedTokenInfo: TokenInfo | null }> => {
  if (!tokenInfo) return { isValid: false, refreshedTokenInfo: null };

  // Deliberately the same first question `checkAndRefreshAuth` asks, so a
  // caller whose token is merely rejected rather than expired still gets
  // "valid, nothing refreshed" and reports it as needing a new sign-in.
  if (isTokenValid(tokenInfo.accessToken, tokenInfo.expiresAt)) {
    return { isValid: true, refreshedTokenInfo: null };
  }

  if (
    latestRefreshed &&
    latestRefreshed.accessToken !== tokenInfo.accessToken &&
    isTokenValid(latestRefreshed.accessToken, latestRefreshed.expiresAt)
  ) {
    return { isValid: true, refreshedTokenInfo: latestRefreshed };
  }

  refreshInFlight ??= checkAndRefreshAuth(tokenInfo)
    .then((result) => {
      if (result.refreshedTokenInfo)
        latestRefreshed = result.refreshedTokenInfo;
      return result;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
};

/** Test seam: forget the in-flight refresh and the token it produced. */
export const resetSharedTokenRefresh = (): void => {
  refreshInFlight = null;
  latestRefreshed = null;
};
