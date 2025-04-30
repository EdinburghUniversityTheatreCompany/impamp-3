/**
 * Utility functions for handling authentication, specifically for Google OAuth
 */

// Check if a token is expired or will expire in the next 5 minutes
export const isTokenExpiredOrExpiring = (expiresAt: number | null): boolean => {
  if (!expiresAt) return true;

  // Consider a token expired if it's within 5 minutes of expiring
  // This gives us a buffer to refresh it before it actually expires
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  return Date.now() + FIVE_MINUTES_MS >= expiresAt;
};

/**
 * Validates the current auth state and attempts to refresh if needed
 * @param accessToken The current access token
 * @param expiresAt When the token expires
 * @param refreshToken The refresh token for getting a new access token
 * @returns Object containing validation results
 */
export const validateAuthState = async (
  accessToken: string | null,
  expiresAt: number | null,
  refreshToken: string | null,
): Promise<{
  isValid: boolean;
  needsReauth: boolean;
  newAccessToken?: string;
  newExpiresAt?: number;
}> => {
  // No tokens at all - needs full authentication
  if (!accessToken) {
    return { isValid: false, needsReauth: true };
  }

  // Check if token is expired or about to expire
  if (!isTokenExpiredOrExpiring(expiresAt)) {
    // Token is still valid
    return { isValid: true, needsReauth: false };
  }

  // Token is expired or about to expire
  // If we have a refresh token, try to refresh
  if (refreshToken) {
    try {
      // Make a request directly to Google's OAuth endpoint to refresh the token
      // This client-side approach works for simple applications, but for more secure
      // implementations, you might want to handle token refresh through a backend

      // Call the real token refresh implementation
      const refreshResult = await refreshGoogleToken(refreshToken);

      if (refreshResult.success) {
        return {
          isValid: true,
          needsReauth: false,
          newAccessToken: refreshResult.accessToken,
          newExpiresAt: refreshResult.expiresAt,
        };
      } else {
        // Refresh failed - user needs to reauthenticate
        return { isValid: false, needsReauth: true };
      }
    } catch (error) {
      console.error("Error refreshing token:", error);
      return { isValid: false, needsReauth: true };
    }
  }

  // No refresh token available
  return { isValid: false, needsReauth: true };
};

// Real implementation of token refresh using Google's OAuth API
async function refreshGoogleToken(refreshToken: string) {
  try {
    // Get client ID from environment variable
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      console.error("Google client ID not configured");
      return { success: false };
    }

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
      return { success: false };
    }

    // Calculate token expiration time (expires_in is in seconds)
    const expiresAt = Date.now() + data.expires_in * 1000;

    // Return successful response with expected format
    return {
      success: true,
      accessToken: data.access_token,
      expiresAt: expiresAt,
    };
  } catch (error) {
    console.error("Error refreshing token:", error);
    return { success: false };
  }
}
