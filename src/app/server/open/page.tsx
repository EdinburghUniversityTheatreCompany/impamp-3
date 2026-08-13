"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfileStore } from "@/store/profileStore";
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
  | { kind: "loading" }
  | { kind: "connecting"; progress: { current: number; total: number } | null }
  | { kind: "success"; profileName: string; readOnly: boolean }
  | { kind: "already-connected"; profileName: string }
  | { kind: "error"; message: string };

function ServerOpenContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const { profiles, updateProfile, importProfileFromSyncData } =
    useProfileStore();
  const { downloadAudioFile } = useGoogleDriveSync();

  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });

  const serverProfileId = searchParams.get("id");
  const shareToken = searchParams.get("token");

  const connect = useCallback(
    async (id: string, token: string) => {
      setPageState({ kind: "connecting", progress: null });

      try {
        const existing = profiles.find((p) => p.serverProfileId === id);
        if (existing) {
          setPageState({
            kind: "already-connected",
            profileName: existing.name,
          });
          return;
        }

        const payload = await fetchServerProfile(id, { shareToken: token });
        if (!payload) {
          // Only a conditional request can 304, and we didn't make one.
          throw new Error("The server returned no profile data.");
        }

        const localProfileId = await importProfileFromSyncData(
          payload.data,
          downloadAudioFile,
          (progress) =>
            setPageState({
              kind: "connecting",
              progress: {
                current: progress.processedFiles,
                total: progress.totalFiles,
              },
            }),
        );

        const readOnly = payload.access === "viewer";
        await updateProfile(localProfileId, {
          syncType: "server",
          serverProfileId: id,
          serverShareToken: token,
          serverVersion: payload.version,
          readOnly,
        });

        setPageState({
          kind: "success",
          profileName: payload.name,
          readOnly,
        });
      } catch (error) {
        setPageState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not open this shared profile.",
        });
      }
    },
    [profiles, updateProfile, importProfileFromSyncData, downloadAudioFile],
  );

  useEffect(() => {
    if (!serverProfileId || !shareToken) {
      setPageState({
        kind: "error",
        message:
          "This link is missing its profile or token. Ask whoever shared it for a fresh link.",
      });
      return;
    }
    void connect(serverProfileId, shareToken);
    // Connecting once per link is the whole job; `connect` changes identity
    // whenever the profile list does, which must not re-run the import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverProfileId, shareToken]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Shared profile
        </h1>

        {pageState.kind === "loading" && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Opening the link…
          </p>
        )}

        {pageState.kind === "connecting" && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {pageState.progress
              ? `Downloading sounds (${pageState.progress.current} of ${pageState.progress.total})…`
              : "Fetching the profile…"}
          </p>
        )}

        {pageState.kind === "already-connected" && (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              You already have <strong>{pageState.profileName}</strong>. It
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

        {pageState.kind === "success" && (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Added <strong>{pageState.profileName}</strong>
              {pageState.readOnly ? " as view-only." : " — you can edit it."}
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

        {pageState.kind === "error" && (
          <>
            <p className="text-sm text-red-600 dark:text-red-400">
              {pageState.message}
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
