"use client";

import React, { useEffect } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { useProfileStore } from "@/store/profileStore";

interface GoogleAuthProviderWrapperProps {
  children: React.ReactNode;
}

const GoogleAuthProviderWrapper: React.FC<GoogleAuthProviderWrapperProps> = ({
  children,
}) => {
  // Access the store only on client side with useEffect
  useEffect(() => {
    // Get the initial state from the store
    const store = useProfileStore.getState();

    // Log auth state on component mount to verify persistence
    console.log("GoogleAuthProviderWrapper mounted");
    console.log("Auth State - isGoogleSignedIn:", store.isGoogleSignedIn);
    console.log(
      "Auth State - googleUser:",
      store.googleUser ? "Present" : "Not present",
    );
    console.log(
      "Auth State - googleAccessToken:",
      store.googleAccessToken ? "Present" : "Not present",
    );

    // No need to subscribe to store changes here as this is just for logging
  }, []);

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  // One behaviour in every environment, and a provider in all of them.
  //
  // `useGoogleLogin` throws outright without an enclosing provider, and it is
  // called during render — `AuthNotification` calls `useGoogleSignIn`
  // unconditionally, on the only page there is. So "no provider" is not
  // "Drive sign-in does nothing"; it is the whole board failing to render.
  //
  // That used to be a production-only argument, and the development branch
  // did exactly the forbidden thing: it returned a setup-instructions box
  // with `children` inside a plain `<div>`. On a clean checkout `npm run dev`
  // — the command both the README and CLAUDE.md give — therefore answered 500
  // on every request with "Google OAuth components must be used within
  // GoogleOAuthProvider", and the board never appeared. The app is fully
  // usable without Google Drive, so failing to start over an optional
  // credential was the wrong trade in the environment where someone is most
  // likely not to have one.
  //
  // With a placeholder the tree renders, the app works, and Drive sign-in
  // fails at the point someone clicks it — which is the honest place for a
  // missing credential to surface. The console is where a developer who
  // *wanted* Drive finds out; `.env.dist` carries the variable.
  if (!clientId) {
    console.error(
      "NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set, so Google Drive sync is " +
        "unavailable. Everything else works. Set it in .env.local (see " +
        ".env.dist) to enable Drive sign-in.",
    );
  }

  return (
    <GoogleOAuthProvider clientId={clientId ?? "unconfigured.invalid"}>
      {children}
    </GoogleOAuthProvider>
  );
};

export default GoogleAuthProviderWrapper;
