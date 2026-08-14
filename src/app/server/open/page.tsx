"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfileStore, whenProfilesLoaded } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { fetchServerProfile } from "@/lib/serverSync/api";

/**
 * Opens a profile from a server share link.
 *
 * Unlike the Drive equivalent this needs no Google sign-in at all: the link
 * token *is* the credential. Signing in only matters for audio, and even that
 * falls back to the public proxy for files shared with "anyone with the link".
 *
 * /server/open?id=<serverProfileId>&token=<shareToken>
 */

type PageState =
  // "connecting" is the initial state: opening the link is the only thing this
  // page does on mount, so there is no earlier state to render. It used to
  // start at "loading" and have the connect() call switch it over, which meant
  // setting state synchronously from the mount effect for a screen nobody saw.
  | { kind: "connecting"; progress: { current: number; total: number } | null }
  | { kind: "success"; profileName: string; readOnly: boolean }
  | { kind: "already-connected"; profileName: string }
  | { kind: "error"; message: string };

function ServerOpenContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const { updateProfile, importProfileFromSyncData } = useProfileStore();
  const { downloadAudioFile } = useGoogleDriveSync();

  const [pageState, setPageState] = useState<PageState>({
    kind: "connecting",
    progress: null,
  });

  const serverProfileId = searchParams.get("id");
  const shareToken = searchParams.get("token");

  // Everything the page does, in the effect that does it. It used to be a
  // useCallback called from the effect, which needed an eslint-disable to stop
  // the effect re-running every time the profile list changed — the one thing
  // that must never happen here, since it would import the profile twice.
  // Inline, the dependencies are just the two halves of the link.
  //
  // The hook functions are read through refs so that a change in their
  // identity (useGoogleDriveSync rebuilds downloadAudioFile whenever the
  // Google token moves) cannot restart the import either.
  const importRef = useRef(importProfileFromSyncData);
  const updateProfileRef = useRef(updateProfile);
  const downloadAudioFileRef = useRef(downloadAudioFile);
  useEffect(() => {
    importRef.current = importProfileFromSyncData;
    updateProfileRef.current = updateProfile;
    downloadAudioFileRef.current = downloadAudioFile;
  });

  useEffect(() => {
    if (!serverProfileId || !shareToken) return;

    let cancelled = false;
    const show = (next: PageState) => {
      if (!cancelled) setPageState(next);
    };

    void (async () => {
      try {
        // Wait for the initial profile load before deciding: this page can
        // mount before it finishes, and an empty list then reads as "not
        // connected yet" and imports a second copy of the profile.
        const loaded = await whenProfilesLoaded();
        const existing = loaded.find(
          (p) => p.serverProfileId === serverProfileId,
        );
        if (existing) {
          show({ kind: "already-connected", profileName: existing.name });
          return;
        }

        const payload = await fetchServerProfile(serverProfileId, {
          shareToken,
        });
        if (!payload) {
          // Only a conditional request can 304, and we didn't make one.
          throw new Error("The server returned no profile data.");
        }

        const localProfileId = await importRef.current(
          payload.data,
          downloadAudioFileRef.current,
          (progress) =>
            show({
              kind: "connecting",
              progress: {
                current: progress.processedFiles,
                total: progress.totalFiles,
              },
            }),
        );

        const readOnly = payload.access === "viewer";
        await updateProfileRef.current(localProfileId, {
          syncType: "server",
          serverProfileId,
          serverShareToken: shareToken,
          serverVersion: payload.version,
          readOnly,
        });

        show({ kind: "success", profileName: payload.name, readOnly });
      } catch (error) {
        show({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not open this shared profile.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverProfileId, shareToken]);

  // A link without both parameters is not a state the page transitions into,
  // it is what the URL already says — so it is derived rather than pushed into
  // state from the effect above.
  const displayState: PageState =
    serverProfileId && shareToken
      ? pageState
      : {
          kind: "error",
          message:
            "This link is missing its profile or token. Ask whoever shared it for a fresh link.",
        };

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Shared profile
        </h1>

        {displayState.kind === "connecting" && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {displayState.progress
              ? `Downloading sounds (${displayState.progress.current} of ${displayState.progress.total})…`
              : "Fetching the profile…"}
          </p>
        )}

        {displayState.kind === "already-connected" && (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              You already have <strong>{displayState.profileName}</strong>. It
              stays in sync automatically.
            </p>
            <button
              onClick={() => router.push("/")}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Go to the soundboard
            </button>
          </>
        )}

        {displayState.kind === "success" && (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Added <strong>{displayState.profileName}</strong>
              {displayState.readOnly ? " as view-only." : " — you can edit it."}
            </p>
            <button
              onClick={() => router.push("/")}
              data-testid="server-open-continue"
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Go to the soundboard
            </button>
          </>
        )}

        {displayState.kind === "error" && (
          <>
            <p className="text-sm text-red-600 dark:text-red-400">
              {displayState.message}
            </p>
            <button
              onClick={() => router.push("/")}
              className="px-3 py-1.5 text-sm bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Back to the soundboard
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default function ServerOpenPage() {
  return (
    <Suspense fallback={null}>
      <ServerOpenContent />
    </Suspense>
  );
}
