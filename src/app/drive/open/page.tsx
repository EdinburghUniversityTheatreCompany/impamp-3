"use client";

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useProfileStore } from "@/store/profileStore";
import { useGoogleSignIn } from "@/hooks/useGoogleSignIn";
import { useConnectDriveProfile } from "@/hooks/useConnectDriveProfile";
import {
  CheckIcon,
  GoogleIcon,
  InfoCircleIcon,
  SpinnerIcon,
  XIcon,
} from "@/components/icons";

const PENDING_FOLDER_KEY = "pendingDriveOpenFolderId";

type PageState =
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
              <GoogleIcon className="w-4 h-4" />
              Sign in with Google
            </button>
          </div>
        )}

        {pageState.kind === "connecting" && (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-2 text-gray-500 dark:text-gray-400">
              <SpinnerIcon className="h-5 w-5" />
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
              <CheckIcon className="w-6 h-6 text-green-600 dark:text-green-400" />
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
              <InfoCircleIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
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
              <XIcon className="w-6 h-6 text-red-600 dark:text-red-400" />
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
            <SpinnerIcon className="h-5 w-5" />
            <span>Loading…</span>
          </div>
        </div>
      }
    >
      <DriveOpenContent />
    </Suspense>
  );
}
