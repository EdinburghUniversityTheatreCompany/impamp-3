"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useGoogleLogin } from "@react-oauth/google";
import { useProfileStore, GoogleUserInfo } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { ProfileSyncData } from "@/lib/syncUtils";
import { blobToBase64 } from "@/lib/importExport";

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

  const {
    isGoogleSignedIn,
    profiles,
    setGoogleAuthDetails,
    updateProfile,
    importProfileFromJSON,
  } = useProfileStore();

  const { listFilesInFolder, downloadDriveFile, downloadAudioFile } =
    useGoogleDriveSync();

  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });
  const [signInError, setSignInError] = useState<string | null>(null);

  // Parse the folder ID from the Google Drive "Open with" state param
  const getFolderIdFromParams = useCallback((): string | null => {
    const rawState = searchParams.get("state");
    if (!rawState) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(rawState));
      return parsed?.ids?.[0] ?? null;
    } catch {
      return null;
    }
  }, [searchParams]);

  const connectToFolder = useCallback(
    async (folderId: string) => {
      setPageState({ kind: "connecting", progress: null });

      try {
        // Check if already connected
        const existing = profiles.find(
          (p) => p.googleDriveFolderId === folderId,
        );
        if (existing) {
          setPageState({
            kind: "already-connected",
            profileName: existing.name,
          });
          return;
        }

        // Find the profile JSON file inside the shared folder
        const files = await listFilesInFolder(folderId);
        const profileFile = files.find((f) => f.name.endsWith(".json"));
        if (!profileFile) {
          throw new Error(
            "No profile file found in the selected folder. Make sure you're selecting an ImpAmp profile folder.",
          );
        }

        const syncData: ProfileSyncData | null = await downloadDriveFile(
          profileFile.id,
        );
        if (
          !syncData ||
          syncData._syncFormatVersion !== 1 ||
          !syncData.profile
        ) {
          throw new Error("Not a valid ImpAmp profile file.");
        }

        // Download audio blobs for any files that only have a driveFileId
        const needsDownload = (syncData.audioFiles ?? []).filter(
          (f) => !f.data && f.driveFileId,
        );
        let enrichedSyncData = syncData;
        if (needsDownload.length > 0) {
          setPageState({
            kind: "connecting",
            progress: { current: 0, total: needsDownload.length },
          });

          const enriched = new Map<number, string>();
          for (let i = 0; i < needsDownload.length; i++) {
            const ref = needsDownload[i];
            try {
              const blob = await downloadAudioFile(ref.driveFileId!);
              if (blob) {
                enriched.set(ref.id, await blobToBase64(blob));
              }
            } catch (err) {
              console.warn(`Failed to download audio "${ref.name}":`, err);
            }
            setPageState({
              kind: "connecting",
              progress: { current: i + 1, total: needsDownload.length },
            });
          }

          enrichedSyncData = {
            ...syncData,
            audioFiles: (syncData.audioFiles ?? []).map((f) =>
              enriched.has(f.id) ? { ...f, data: enriched.get(f.id) } : f,
            ),
          };
        }

        // Convert sync format to export format and import as a new local profile
        const profileCopy = { ...enrichedSyncData.profile };
        const exportData = {
          exportVersion: 2,
          exportDate: new Date().toISOString(),
          profile: {
            ...profileCopy,
            id: undefined,
            syncType: "googleDrive" as const,
            lastBackedUpAt: Date.now(),
          },
          padConfigurations: enrichedSyncData.padConfigurations || [],
          pageMetadata: enrichedSyncData.pageMetadata || [],
          audioFiles: (enrichedSyncData.audioFiles || []).filter(
            (f): f is typeof f & { data: string } => typeof f.data === "string",
          ),
        };

        const profileIdsBefore = new Set(profiles.map((p) => p.id));
        await importProfileFromJSON(JSON.stringify(exportData));

        // Find the newly created profile and link it to the shared Drive folder
        const updatedProfiles = useProfileStore.getState().profiles;
        const newProfile = updatedProfiles.find(
          (p) => !profileIdsBefore.has(p.id),
        );
        if (newProfile?.id) {
          await updateProfile(newProfile.id, {
            googleDriveFileId: profileFile.id,
            googleDriveFolderId: folderId,
          });
        }

        sessionStorage.removeItem(PENDING_FOLDER_KEY);
        setPageState({
          kind: "success",
          profileName: enrichedSyncData.profile.name,
        });
      } catch (error) {
        console.error("Failed to connect shared Drive profile:", error);
        setPageState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to connect profile.",
        });
      }
    },
    [
      profiles,
      listFilesInFolder,
      downloadDriveFile,
      downloadAudioFile,
      importProfileFromJSON,
      updateProfile,
    ],
  );

  // On mount: parse state param and either connect (if signed in) or prompt sign-in
  useEffect(() => {
    const folderId = getFolderIdFromParams();
    if (!folderId) {
      setPageState({
        kind: "error",
        message: "No folder ID found in the URL.",
      });
      return;
    }

    if (isGoogleSignedIn) {
      connectToFolder(folderId);
    } else {
      sessionStorage.setItem(PENDING_FOLDER_KEY, folderId);
      setPageState({ kind: "needs-signin" });
    }
    // Run once on mount — connectToFolder is stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const googleLogin = useGoogleLogin({
    flow: "auth-code",
    scope: "https://www.googleapis.com/auth/drive.file",
    onSuccess: async ({ code }) => {
      setSignInError(null);
      try {
        const exchangeResponse = await fetch("/api/auth/google/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });

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

        const userInfoResponse = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
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

        // Now connect using the folder ID we saved before sign-in
        const pendingFolderId = sessionStorage.getItem(PENDING_FOLDER_KEY);
        if (pendingFolderId) {
          await connectToFolder(pendingFolderId);
        } else {
          setPageState({
            kind: "error",
            message: "Lost track of the folder to connect. Please try again.",
          });
        }
      } catch (error) {
        console.error("Sign-in failed:", error);
        setSignInError(
          error instanceof Error
            ? error.message
            : "Sign-in failed. Please try again.",
        );
      }
    },
    onError: (errorResponse) => {
      setSignInError(
        `Sign-in failed: ${errorResponse.error_description || errorResponse.error || "Unknown error"}`,
      );
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
                  ? `Downloading audio (${pageState.progress.current}/${pageState.progress.total})…`
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
                &ldquo;{pageState.profileName}&rdquo; connected!
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                The profile has been added to your ImpAmp3.
              </p>
            </div>
            <button
              onClick={handleGoToApp}
              className="w-full px-4 py-2.5 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 transition-colors"
            >
              Open ImpAmp3
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
                &ldquo;{pageState.profileName}&rdquo; is already connected.
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                This profile is already in your ImpAmp3.
              </p>
            </div>
            <button
              onClick={handleGoToApp}
              className="w-full px-4 py-2.5 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 transition-colors"
            >
              Open ImpAmp3
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
              Go to ImpAmp3
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
