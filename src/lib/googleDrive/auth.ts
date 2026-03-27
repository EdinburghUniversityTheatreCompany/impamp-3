/**
 * Authentication handling for Google Drive integration
 * Manages token validation, refresh, and authentication state
 */

import { isTokenValid } from "./utils";
import { TokenInfo } from "./types";

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

    const response = await fetch("/api/auth/google/refresh", {
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
