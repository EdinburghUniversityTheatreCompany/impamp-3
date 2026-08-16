"use client";

/**
 * Signing in to Google, in one place.
 *
 * The auth-code flow is the same five steps everywhere it appears: POST the
 * code to `/api/auth/google/exchange` so the client secret stays server-side,
 * read `access_token` / `refresh_token` / `expires_in`, turn the last into an
 * absolute `expiresAt`, fetch the user's profile from the userinfo endpoint,
 * and hand all of it to `setGoogleAuthDetails`.
 *
 * It was written out three times — in `ProfileManager`, in `AuthNotification`
 * and in `/drive/open` — character for character, differing only in what each
 * did *afterwards*. Three places to change when the token contract moves, and
 * three places for the requested `scope` to drift apart, with nothing making
 * them agree.
 *
 * @module hooks/useGoogleSignIn
 */

import { useCallback } from "react";
import { useGoogleLogin } from "@react-oauth/google";
import { useProfileStore } from "@/store/profileStore";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type { GoogleUserInfo } from "@/store/profileStore";

/**
 * The Drive scope this app asks for.
 *
 * `drive.file` only — access to files this app created or the user explicitly
 * opened, never the whole Drive. Shared so the three sign-in entry points
 * cannot ask for different things.
 */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface UseGoogleSignInOptions {
  /** Runs after the tokens and user info are stored. */
  onSignedIn?: (user: GoogleUserInfo) => void;
  /** Anything that went wrong, already turned into a sentence. */
  onError?: (message: string) => void;
}

/**
 * Returns a function that starts the Google sign-in popup.
 *
 * @param options - What to do once it succeeds, and how to report failure
 * @returns A zero-argument trigger, as `useGoogleLogin` returns
 */
export function useGoogleSignIn({
  onSignedIn,
  onError,
}: UseGoogleSignInOptions = {}) {
  const setGoogleAuthDetails = useProfileStore((s) => s.setGoogleAuthDetails);
  const clearGoogleAuthDetails = useProfileStore(
    (s) => s.clearGoogleAuthDetails,
  );

  const report = useCallback(
    (error: unknown, fallback: string) => {
      const message = error instanceof Error ? error.message : fallback;
      console.error("[Google sign-in]", error);
      onError?.(message);
    },
    [onError],
  );

  return useGoogleLogin({
    flow: "auth-code",
    scope: GOOGLE_DRIVE_SCOPE,
    onSuccess: async ({ code }) => {
      try {
        // Exchanged server-side so the client secret is never in the browser.
        const exchangeResponse = await fetchWithTimeout(
          "/api/auth/google/exchange",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          },
        );

        if (!exchangeResponse.ok) {
          const err = await exchangeResponse.json().catch(() => ({}));
          throw new Error(err.error || "Failed to exchange authorization code");
        }

        const {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: expiresIn,
        } = await exchangeResponse.json();

        const expiresAt = Date.now() + expiresIn * 1000;

        const userInfoResponse = await fetchWithTimeout(USERINFO_ENDPOINT, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userInfoResponse.ok) {
          throw new Error(
            `Failed to fetch user info: ${userInfoResponse.statusText}`,
          );
        }

        const userInfo: GoogleUserInfo = await userInfoResponse.json();

        setGoogleAuthDetails(
          userInfo,
          accessToken,
          refreshToken ?? null,
          expiresAt,
        );
        onSignedIn?.(userInfo);
      } catch (error) {
        report(error, "Failed to complete Google sign-in.");
      }
    },
    onError: (errorResponse) => {
      console.error("[Google sign-in] popup failed:", errorResponse);
      onError?.(
        `Login failed: ${errorResponse.error_description || errorResponse.error || "Unknown error"}`,
      );
      // The popup failing mid-flow can leave a half-written slice behind.
      clearGoogleAuthDetails();
    },
  });
}
