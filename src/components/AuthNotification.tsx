"use client";

/**
 * AuthNotification component to inform users about authentication status
 * Display this component to let users know they need to sign in again
 * if their token has expired
 */

import React, { useState, useCallback, useEffect } from "react";
import { useProfileStore, GoogleUserInfo } from "@/store/profileStore";
import { useGoogleLogin, TokenResponse } from "@react-oauth/google";

interface AuthNotificationProps {
  // Optional class name for styling
  className?: string;
}

/**
 * Component that displays a notification when authentication is needed
 * Shows a sign in button when the user needs to re-authenticate
 */
export const AuthNotification: React.FC<AuthNotificationProps> = ({
  className,
}) => {
  // Use useState to store values
  const [authState, setAuthState] = useState({
    isGoogleSignedIn: false,
    needsReauth: false,
  });
  const [googleApiError, setGoogleApiError] = useState<string | null>(null);

  // Define types for our state
  interface AuthState {
    isGoogleSignedIn: boolean;
    needsReauth: boolean;
  }

  // Define a type for the store state that only includes what we need
  interface StoreState {
    isGoogleSignedIn: boolean;
    needsReauth: boolean;
  }

  // Get setGoogleAuthDetails function directly from store
  const setGoogleAuthDetails = useProfileStore(
    (state) => state.setGoogleAuthDetails,
  );
  const clearGoogleAuthDetails = useProfileStore(
    (state) => state.clearGoogleAuthDetails,
  );

  // Memoize the selector to prevent unnecessary re-renders
  const selectAuthState = useCallback(
    (state: StoreState): AuthState => ({
      isGoogleSignedIn: state.isGoogleSignedIn,
      needsReauth: state.needsReauth,
    }),
    [],
  );

  // Google login handler using the Google OAuth library
  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      console.log(
        "Google Login Success (from AuthNotification):",
        tokenResponse,
      );
      setGoogleApiError(null);
      const accessToken = tokenResponse.access_token;

      try {
        const userInfoResponse = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );

        if (!userInfoResponse.ok) {
          throw new Error(
            `Failed to fetch user info: ${userInfoResponse.statusText}`,
          );
        }

        const userInfo: GoogleUserInfo = await userInfoResponse.json();
        console.log("Fetched Google User Info:", userInfo);

        // Calculate token expiration time (usually 1 hour from now for Google)
        const expiresAt = Date.now() + 3600 * 1000; // 1 hour in milliseconds

        // Define an extended token type that includes refresh_token
        interface ExtendedTokenResponse extends TokenResponse {
          refresh_token?: string;
        }

        // Get refresh token if available
        const refreshToken =
          (tokenResponse as ExtendedTokenResponse).refresh_token || null;

        // Store Google auth details with refresh token and expiration
        setGoogleAuthDetails(userInfo, accessToken, refreshToken, expiresAt);

        console.log(
          "Google authentication successful and stored in profile store",
        );
      } catch (error) {
        console.error("Error fetching Google user info:", error);
        setGoogleApiError(
          error instanceof Error
            ? error.message
            : "Failed to fetch user details after login.",
        );
      }
    },
    onError: (errorResponse) => {
      console.error("Google Login Failed:", errorResponse);
      setGoogleApiError(
        `Login failed: ${errorResponse.error_description || errorResponse.error || "Unknown error"}`,
      );
      clearGoogleAuthDetails();
    },
    scope: "https://www.googleapis.com/auth/drive.file",
  });

  // Use useEffect to access the store only on the client side
  useEffect(() => {
    // Get initial state
    const storeState = useProfileStore.getState();
    setAuthState({
      isGoogleSignedIn: storeState.isGoogleSignedIn,
      needsReauth: storeState.needsReauth,
    });

    // Subscribe to store changes
    const unsubscribe = useProfileStore.subscribe((state) => {
      const newState = selectAuthState(state);
      setAuthState(newState);
    });

    // Cleanup subscription
    return () => unsubscribe();
  }, [selectAuthState]);

  // Only show when signed in but needs reauth
  if (!authState.isGoogleSignedIn || !authState.needsReauth) {
    return null;
  }

  return (
    <div
      className={`bg-red-50 border border-red-300 rounded-md my-4 text-center shadow-sm ${className || ""}`}
    >
      <div className="flex flex-col items-center">
        <p className="mb-4 text-red-700 font-medium">
          Your Google authentication has expired. Please sign in again to
          continue syncing.
        </p>
        <button
          onClick={() => googleLogin()}
          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors font-medium"
        >
          Sign in with Google
        </button>

        {googleApiError && (
          <p className="mt-2 text-xs text-red-600">Error: {googleApiError}</p>
        )}
      </div>
    </div>
  );
};

export default AuthNotification;
