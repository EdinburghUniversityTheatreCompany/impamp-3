"use client";

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useProfileStore } from "@/store/profileStore";
import { useGoogleSignIn } from "@/hooks/useGoogleSignIn";
import { useConnectDriveProfile } from "@/hooks/useConnectDriveProfile";

const PENDING_FOLDER_KEY = "pendingDriveOpenFolderId";

type PageState =
  | { kind: "loading" }
  | { kind: "needs-signin" }
  | { kind: "connecting"; progress: { current: number; total: number } | null }
  | { kind: "success"; profileName: string }
  | { kind: "already-connected"; profileName: string }
  | { kind: "error"; message: string };

function DriveOpenContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const isGoogleSignedIn = useProfileStore((s) => s.isGoogleSignedIn);
  const { connectByFolderId } = useConnectDriveProfile();

  // The folder ID out of the Google Drive "Open with" state param.
  const initialFolderId = useMemo((): string | null => {
    const rawState = searchParams.get("state");
    if (!rawState) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(rawState));
      return parsed?.ids?.[0] ?? null;
    } catch {
      return null;
    }
  }, [searchParams]);

  // The first three outcomes are decided by the URL and the sign-in state, so
  // they are the initial state rather than something the mount effect below
  // pushes in: a link with no folder id is an error, and a valid one is either
  // already connecting or waiting for sign-in.
  const [pageState, setPageState] = useState<PageState>(() =>
    !initialFolderId
      ? { kind: "error", message: "No folder ID found in the URL." }
      : useProfileStore.getState().isGoogleSignedIn
        ? { kind: "connecting", progress: null }
        : { kind: "needs-signin" },
  );
  const [signInError, setSignInError] = useState<string | null>(null);

  // Callers put the page into "connecting" themselves — the mount path starts
  // there (see the initial state below) and the sign-in handler is an event,
  // so neither needs this function to set state before its first await.
  const connectToFolder = useCallback(
    async (folderId: string) => {
      try {
        const outcome = await connectByFolderId(folderId, {
          onProgress: (p) =>
            setPageState({
              kind: "connecting",
              progress: { current: p.processedFiles, total: p.totalFiles },
            }),
        });

        if (outcome.kind === "already-connected") {
          setPageState({
            kind: "already-connected",
            profileName: outcome.name,
          });
          return;
        }

        sessionStorage.removeItem(PENDING_FOLDER_KEY);
        setPageState({ kind: "success", profileName: outcome.name });
      } catch (error) {
        console.error("Failed to connect shared Drive profile:", error);
        setPageState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not connect that shared profile.",
        });
      }
    },
    [connectByFolderId],
  );

  // On mount: start connecting, or park the folder id until sign-in completes.
  useEffect(() => {
    if (!initialFolderId) return;

    if (!isGoogleSignedIn) {
      sessionStorage.setItem(PENDING_FOLDER_KEY, initialFolderId);
      return;
    }

    // connectToFolder sets no state before its first await, so this cannot
    // cascade a render — but the rule cannot see through a call into an async
    // function, only through one written inline, and inlining a 50-line import
    // that the sign-in handler below also calls would be worse.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void connectToFolder(initialFolderId);
    // Run once on mount — connectToFolder is stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const googleLogin = useGoogleSignIn({
    onError: setSignInError,
    onSignedIn: async () => {
      // Connect using the folder ID saved before the popup opened.
      const pendingFolderId = sessionStorage.getItem(PENDING_FOLDER_KEY);
      if (!pendingFolderId) {
        setPageState({
          kind: "error",
          message: "Lost track of the folder to connect. Please try again.",
        });
        return;
      }

      try {
        await connectToFolder(pendingFolderId);
      } catch (error) {
        console.error("Sign-in failed:", error);
        setSignInError(
          error instanceof Error
            ? error.message
            : "Sign-in failed. Please try again.",
        );
      }
    },
  });

  const handleGoToApp = () => router.push("/");

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
            ImpAmp3
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Connect shared profile
          </p>
        </div>

        {pageState.kind === "loading" && (
          <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
            <svg
              className="animate-spin h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
            <span>Loading…</span>
          </div>
        )}

        {pageState.kind === "needs-signin" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Sign in with Google to connect this shared profile to your
              ImpAmp3.
            </p>
            {signInError && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {signInError}
              </p>
            )}
            <button
              onClick={() => googleLogin()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Sign in with Google
            </button>
          </div>
        )}

        {pageState.kind === "connecting" && (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
              <svg
                className="animate-spin h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8H4z"
                />
              </svg>
              <span>
                {pageState.progress
                  ? `Downloading sounds (${pageState.progress.current} of ${pageState.progress.total})…`
                  : "Connecting…"}
              </span>
            </div>
          </div>
        )}

        {pageState.kind === "success" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 mx-auto">
              <svg
                className="w-6 h-6 text-green-600 dark:text-green-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Added &ldquo;{pageState.profileName}&rdquo;.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                It stays in sync with the shared Drive folder.
              </p>
            </div>
            <button
              onClick={handleGoToApp}
              className="w-full px-4 py-2.5 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 transition-colors"
            >
              Go to the soundboard
            </button>
          </div>
        )}

        {pageState.kind === "already-connected" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 mx-auto">
              <svg
                className="w-6 h-6 text-blue-600 dark:text-blue-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                You already have &ldquo;{pageState.profileName}&rdquo;.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                It stays in sync automatically.
              </p>
            </div>
            <button
              onClick={handleGoToApp}
              className="w-full px-4 py-2.5 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 transition-colors"
            >
              Go to the soundboard
            </button>
          </div>
        )}

        {pageState.kind === "error" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 mx-auto">
              <svg
                className="w-6 h-6 text-red-600 dark:text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Connection failed
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {pageState.message}
              </p>
            </div>
            <button
              onClick={handleGoToApp}
              className="w-full px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Go to the soundboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function DriveOpenPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <svg
              className="animate-spin h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
            <span>Loading…</span>
          </div>
        </div>
      }
    >
      <DriveOpenContent />
    </Suspense>
  );
}
