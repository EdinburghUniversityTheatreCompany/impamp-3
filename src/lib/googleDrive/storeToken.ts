/**
 * The Google Drive token, read from and written back to the profile store.
 *
 * Both halves used to be written by hand at each call site — four copies of
 * the read in `useGoogleDriveSync`, `useServerSync` and `useProfileSync`, and
 * three of the write — and the copies drifted on exactly the field that
 * matters: only the Drive hook's write refused a refresh that arrived without
 * an access token.
 *
 * That guard is load-bearing. `refreshAccessToken` returns
 * `accessToken: data.access_token` unvalidated, so a 200 that omits the field
 * yields `accessToken: undefined`; installing it writes `isGoogleSignedIn:
 * true` with no usable token and, because `setGoogleAuthDetails` always
 * clears `needsReauth`, erases the one flag that would have prompted the user
 * to sign in again. Nothing downstream can tell the difference afterwards —
 * the request simply 401s, and the app believes it is signed in.
 */

import { useProfileStore } from "@/store/profileStore";
import type { TokenInfo } from "./types";

/** The fields of the store this module reads. */
export interface DriveAuthSlice {
  isGoogleSignedIn: boolean;
  googleAccessToken: string | null;
  googleRefreshToken: string | null;
  tokenExpiresAt: number | null;
}

/**
 * The token in a snapshot of the auth slice, or null if there isn't one.
 *
 * Pure, so a React memo over mirrored state and a call-time store read give
 * the same answer by construction rather than by two people remembering the
 * same three conditions.
 */
export function driveTokenFrom(slice: DriveAuthSlice): TokenInfo | null {
  if (!slice.isGoogleSignedIn || !slice.googleAccessToken) return null;
  return {
    accessToken: slice.googleAccessToken,
    refreshToken: slice.googleRefreshToken,
    expiresAt: slice.tokenExpiresAt || 0,
  };
}

/** The Drive token as it is *now*, not as it was at the last render. */
export function currentDriveToken(): TokenInfo | null {
  return driveTokenFrom(useProfileStore.getState());
}

/**
 * Install a refreshed token, keeping the user we already know about.
 *
 * A refresh without an access token is not a refresh, so it is dropped: the
 * old token stays, and so does `needsReauth`. `setGoogleAuthDetails` clears
 * that flag itself, which is why this must not be reached with a token that
 * cannot be used.
 *
 * The user is read from the store rather than closed over, because a handler
 * built during one render and called during a later sync would otherwise
 * overwrite a signed-in user with the empty placeholder.
 */
export function applyDriveTokenRefresh(token: TokenInfo): void {
  if (!token.accessToken) {
    console.warn("Ignoring a Google token refresh that carried no token.");
    return;
  }
  const store = useProfileStore.getState();
  store.setGoogleAuthDetails(
    store.googleUser ?? { name: "", email: "" },
    token.accessToken,
    token.refreshToken ?? null,
    token.expiresAt,
  );
}
