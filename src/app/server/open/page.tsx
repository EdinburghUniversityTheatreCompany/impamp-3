"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConnectServerProfile } from "@/hooks/useConnectServerProfile";

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

  const connectServerProfile = useConnectServerProfile();

  const [pageState, setPageState] = useState<PageState>({
    kind: "connecting",
    progress: null,
  });

  const serverProfileId = searchParams.get("id");
  const shareToken = searchParams.get("token");

  // The connect callback is read through a ref so a change in its identity
  // cannot restart the import — `useConnectServerProfile` depends on
  // `downloadAudioFile`, which `useGoogleDriveSync` rebuilds whenever the
  // Google token moves, and importing the profile twice is the one thing that
  // must never happen here. The effect's real dependencies are the two halves
  // of the link.
  const connectRef = useRef(connectServerProfile);
  useEffect(() => {
    connectRef.current = connectServerProfile;
  });

  useEffect(() => {
    if (!serverProfileId || !shareToken) return;

    let cancelled = false;
    const show = (next: PageState) => {
      if (!cancelled) setPageState(next);
    };

    void (async () => {
      try {
        // This page used to run the whole five-step sequence itself, and had
        // drifted from the hook on the one line that matters: it imported with
        // `{ syncType: "server" }` up front, which is exactly what the hook's
        // comment describes as broken — a crash before `serverProfileId` was
        // written left a profile typed "server" with no id, which the next
        // background sync reads as "adopt me" and answers by creating a second
        // server profile. It also never learned how to fetch server-hosted
        // audio, so on a deployment with hosted audio every pad arrived empty.
        const outcome = await connectRef.current(serverProfileId, {
          shareToken,
          onProgress: (progress) =>
            show({
              kind: "connecting",
              progress: {
                current: progress.processedFiles,
                total: progress.totalFiles,
              },
            }),
        });

        if (outcome.kind === "already-connected") {
          show({ kind: "already-connected", profileName: outcome.name });
          return;
        }

        show({
          kind: "success",
          profileName: outcome.name,
          readOnly: outcome.readOnly,
        });
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
