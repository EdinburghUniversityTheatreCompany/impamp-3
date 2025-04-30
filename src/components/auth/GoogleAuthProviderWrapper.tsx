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

  // Ensure the environment variable is set, otherwise throw an error during development
  // In production, it might be better to handle this gracefully, but for setup, an error is clear.
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  if (!clientId) {
    // Provide a helpful error message if the Client ID is missing

    if (process.env.NODE_ENV === "development") {
      console.error(
        "ERROR: NEXT_PUBLIC_GOOGLE_CLIENT_ID environment variable is not set.",
      );
      return (
        <div
          style={{
            padding: "20px",
            backgroundColor: "#ffdddd",
            border: "1px solid #ff0000",
            color: "#d8000c",
          }}
        >
          <h2>Google Client ID Missing</h2>
          <p>
            The <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> environment variable
            is required for Google Drive Sync functionality.
          </p>
          <p>
            Please create a <code>.env.local</code> file in the project root and
            add the following line:
          </p>
          <pre>NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-google-client-id-here</pre>
          <p>
            You can obtain a Client ID from the Google Cloud Console after
            setting up your OAuth 2.0 credentials. Refer to the project
            documentation for setup steps.
          </p>
          {children}{" "}
          {/* Render children anyway in dev to allow other parts of the app to load */}
        </div>
      );
    } else {
      // In production, maybe just log an error and don't render the provider
      console.error("Google Client ID is not configured.");
      // Render children without the provider in production if ID is missing
      return <>{children}</>;
    }
  }

  return (
    <GoogleOAuthProvider clientId={clientId}>{children}</GoogleOAuthProvider>
  );
};

export default GoogleAuthProviderWrapper;
