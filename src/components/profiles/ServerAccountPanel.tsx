"use client";

/**
 * The account you have on the ImpAmp server, and how to leave it.
 *
 * There was no sign of one. Signing in to Google establishes a server session
 * as a side effect of the same code exchange, so anyone who used Drive sync
 * had a server account and was never told — the only trace was whether the
 * "Sync to ImpAmp server" button happened to render. `signOutOfServer` existed
 * and was called from nowhere, so "Sign Out" ended the Google session and left
 * the server cookie in place.
 */

import { useState } from "react";
import { signOutOfServer } from "@/lib/serverSync/api";
import { forgetAudioCapability } from "@/lib/serverAudio/transfer";
import { useServerSync } from "@/hooks/useServerSync";

export default function ServerAccountPanel() {
  const { serverUser, isCheckingSession, refreshSession } = useServerSync();
  const [signingOut, setSigningOut] = useState(false);

  if (isCheckingSession) return null;

  if (!serverUser) {
    return (
      <div
        data-testid="server-account"
        className="text-sm text-gray-500 dark:text-gray-400"
      >
        No account on this ImpAmp server. Signing in with Google creates one, if
        this server allows your address.
      </div>
    );
  }

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOutOfServer();
      // The next account may have different upload rights, and the answer is
      // cached for the session.
      forgetAudioCapability();
      await refreshSession();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div
      data-testid="server-account"
      className="flex flex-wrap items-center gap-3"
    >
      <div className="flex-1">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {serverUser.email}
          {serverUser.isAdmin && (
            <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
              Admin
            </span>
          )}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {serverUser.canUploadAudio
            ? "This account may store sounds on the server."
            : "Sounds for this account stay in Google Drive."}
        </p>
      </div>

      <a
        href="/server/storage"
        data-testid="server-storage-link"
        className="rounded-md bg-gray-100 px-3 py-1.5 text-sm text-gray-800 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
      >
        Server storage
      </a>

      <button
        onClick={handleSignOut}
        disabled={signingOut}
        data-testid="server-sign-out"
        className="rounded-md bg-red-100 px-3 py-1.5 text-sm text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
      >
        {signingOut ? "Signing out…" : "Sign out of server sync"}
      </button>
    </div>
  );
}
