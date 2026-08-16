"use client";

/**
 * AuthNotification component to inform users about authentication status
 * Display this component to let users know they need to sign in again
 * if their token has expired
 */

import React, { useState, useCallback, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { useGoogleSignIn } from "@/hooks/useGoogleSignIn";

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

  // Memoize the selector to prevent unnecessary re-renders
  const selectAuthState = useCallback(
    (state: StoreState): AuthState => ({
      isGoogleSignedIn: state.isGoogleSignedIn,
      needsReauth: state.needsReauth,
    }),
    [],
  );

  // Google login handler using the Google OAuth library
  const googleLogin = useGoogleSignIn({
    onError: setGoogleApiError,
  });

  // Mirror the store's auth slice into React state, rather than reading it
  // through useProfileStore(...) directly: the store is persisted, so what the
  // server rendered and what localStorage holds can differ, and this keeps the
  // first client render matching the server's.
  //
  // Selector-based (see subscribeWithSelector in profileStore), so it is woken
  // only when one of these two fields changes; fireImmediately replaces the
  // separate read-initial-state step.
  useEffect(
    () =>
      useProfileStore.subscribe(selectAuthState, setAuthState, {
        equalityFn: (a, b) =>
          a.isGoogleSignedIn === b.isGoogleSignedIn &&
          a.needsReauth === b.needsReauth,
        fireImmediately: true,
      }),
    [selectAuthState],
  );

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
