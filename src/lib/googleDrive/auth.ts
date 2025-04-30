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
 * Attempts to refresh an expired access token
 * @param refreshToken The refresh token to use
 * @returns New token info or null if refresh failed
 */
export const refreshAccessToken = async (
  refreshToken: string | null,
): Promise<TokenInfo | null> => {
  if (!refreshToken) return null;

  try {
    // Get client ID from environment variable
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error("Google client ID not configured");
    }

    console.log("Refreshing access token with refresh token...");

    // Form data for token refresh
    const formData = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    // Call Google's OAuth token endpoint
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Token refresh failed:", data);
      throw new Error(
        data.error_description || data.error || "Token refresh failed",
      );
    }

    // Calculate token expiration time (expires_in is in seconds)
    const expiresAt = Date.now() + data.expires_in * 1000;

    // Return successful response
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
