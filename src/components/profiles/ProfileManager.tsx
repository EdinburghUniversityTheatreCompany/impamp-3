"use client";

import { useState, useEffect, useRef, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useProfileStore } from "@/store/profileStore";
import { MissingAudioFile } from "@/lib/db";
import ProfileCard from "./ProfileCard";
import ServerAccountPanel from "./ServerAccountPanel";
import ConnectProfileList from "./ConnectProfileList";
import { googleLogout } from "@react-oauth/google";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { ProfileSyncData } from "@/lib/syncUtils";
import type { TransferProgress } from "@/lib/importExport";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { useGoogleSignIn } from "@/hooks/useGoogleSignIn";
import { useConnectDriveProfile } from "@/hooks/useConnectDriveProfile";
import { useEscapeToClose } from "@/hooks/modal/useEscapeToClose";
import { useShallow } from "zustand/react/shallow";

/**
 * Progress bar shown while a ZIP export/import streams audio files.
 */
function TransferProgressBar({
  progress,
  verb,
}: {
  progress: TransferProgress;
  verb: string;
}) {
  const percent =
    progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round((progress.processedBytes / progress.totalBytes) * 100),
        )
      : progress.phase === "finalizing"
        ? 100
        : 0;
  const label =
    progress.phase === "preparing"
      ? "Preparing…"
      : progress.phase === "finalizing"
        ? "Finalizing…"
        : `${verb} ${progress.fileName ?? "audio"} (${Math.min(
            progress.processedFiles + 1,
            progress.totalFiles,
          )}/${progress.totalFiles})`;

  return (
    <div className="mt-3" data-testid="transfer-progress">
      <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
        <span className="truncate pr-2">{label}</span>
        <span className="shrink-0">{percent}%</span>
      </div>
      <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * An ImpAmp share link, if that is what this is.
 *
 * Matched on the path and the two parameters rather than on the origin: a
 * deployment can be reached by more than one hostname, and a link copied from
 * one is still a link to the same profile on the same server.
 */
function parseServerShareUrl(
  raw: string,
): { id: string; token: string } | null {
  try {
    const url = new URL(raw.trim(), window.location.origin);
    if (!url.pathname.endsWith("/server/open")) return null;
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    return id && token ? { id, token } : null;
  } catch {
    return null;
  }
}

export default function ProfileManager() {
  // `useShallow`, not a bare `useProfileStore()`. Under Zustand v5 the bare
  // form compares the whole state object, so every sync tick,
  // `padConfigsVersion` bump, bank switch and token refresh re-rendered all of
  // this — 29 useState calls and a 615-line hook — even while the manager was
  // closed. It is only mounted while open now (ProfileManagerHost), but a
  // fifteen-field read still has no business waking on an unrelated field.
  const {
    profiles,
    activeProfileId,
    closeProfileManager,
    createProfile,
    importProfileFromJSON,
    importProfileFromImpamp2JSON,
    importMultipleProfilesFromJSON,
    exportMultipleProfilesToZip,
    importProfilesFromZip,
    isGoogleSignedIn,
    googleUser,
    googleAccessToken,
    clearGoogleAuthDetails,
  } = useProfileStore(
    useShallow((s) => ({
      profiles: s.profiles,
      activeProfileId: s.activeProfileId,
      closeProfileManager: s.closeProfileManager,
      createProfile: s.createProfile,
      importProfileFromJSON: s.importProfileFromJSON,
      importProfileFromImpamp2JSON: s.importProfileFromImpamp2JSON,
      importMultipleProfilesFromJSON: s.importMultipleProfilesFromJSON,
      exportMultipleProfilesToZip: s.exportMultipleProfilesToZip,
      importProfilesFromZip: s.importProfilesFromZip,
      isGoogleSignedIn: s.isGoogleSignedIn,
      googleUser: s.googleUser,
      googleAccessToken: s.googleAccessToken,
      clearGoogleAuthDetails: s.clearGoogleAuthDetails,
    })),
  );

  // Escape dismisses the manager. `ProfileCard` opens modals from inside this
  // panel, and the hook's stack is what makes that safe: a dialog opened from
  // here keeps its own Escape, and closing it hands Escape back to this.
  //
  // `true`, not the store's flag: `ProfileManagerHost` mounts this component
  // only while the manager is open, so being rendered at all *is* being open.
  // `WaveformTrimmer` passes a literal for the same reason.
  useEscapeToClose(true, closeProfileManager);

  const router = useRouter();

  // State management
  const [newProfileName, setNewProfileName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "profiles" | "import-export" | "maintenance"
  >("profiles");

  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<TransferProgress | null>(
    null,
  );
  const [importProgress, setImportProgress] = useState<TransferProgress | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [exportSelectionIds, setExportSelectionIds] = useState<Set<number>>(
    new Set(),
  ); // State for export selection

  // Drive audio repair state
  const [isRepairingDriveAudio, setIsRepairingDriveAudio] = useState(false);
  const [driveAudioRepairResult, setDriveAudioRepairResult] = useState<{
    profilesChecked: number;
    filesChecked: number;
    filesUploaded: number;
    errors: string[];
  } | null>(null);
  const [driveAudioRepairProgress, setDriveAudioRepairProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Orphan cleanup state
  const [isCleaningOrphans, setIsCleaningOrphans] = useState(false);
  const [orphanCleanupResult, setOrphanCleanupResult] = useState<{
    deletedCount: number;
    cacheEntriesCleared: number;
    errors: string[];
  } | null>(null);
  const [orphanScanResult, setOrphanScanResult] = useState<{
    orphanedIds: Set<number>;
    referencedIds: Set<number>;
    totalAudioFiles: number;
  } | null>(null);
  const [isScanningOrphans, setIsScanningOrphans] = useState(false);

  // Missing audio files state
  const [isScanningMissing, setIsScanningMissing] = useState(false);
  const [missingScanResult, setMissingScanResult] = useState<
    MissingAudioFile[] | null
  >(null);
  const [replacingIds, setReplacingIds] = useState<Set<string>>(new Set());
  const [replacedIds, setReplacedIds] = useState<Set<string>>(new Set());

  // Connect to shared profile state
  const drivePickerRef = useRef<HTMLElement>(null);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectSuccess, setConnectSuccess] = useState<string | null>(null);
  const [audioDownloadProgress, setAudioDownloadProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handler for export selection changes
  const handleExportSelectChange = (profileId: number, isSelected: boolean) => {
    setExportSelectionIds((prevSelected) => {
      const newSelected = new Set(prevSelected);
      if (isSelected) {
        newSelected.add(profileId);
      } else {
        newSelected.delete(profileId);
      }
      return newSelected;
    });
  };

  const [googleApiError, setGoogleApiError] = useState<string | null>(null);

  const [shareConnectReadOnly, setShareConnectReadOnly] = useState(false);

  // Hooks
  const { downloadDriveFile, repairDriveAudio } = useGoogleDriveSync();
  const { connectByFolderId, connectWithSyncData } = useConnectDriveProfile();

  /**
   * Imports Drive sync data as a new local profile, streaming each audio
   * file (Drive download or legacy embedded base64) straight into IndexedDB
   * one at a time — no base64 round-trip, no whole-profile JSON string.
   * Shows download progress while audio is fetched. Returns the new
   * profile's ID so the caller can link it to Drive.
   */

  const googleLogin = useGoogleSignIn({
    onError: setGoogleApiError,
  });

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) {
      alert("Please enter a profile name");
      return;
    }
    try {
      setIsCreating(true);
      await createProfile({
        name: newProfileName.trim(),
        syncType: "local",
      });
      setNewProfileName("");
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to create profile:", error);
      alert("Failed to create profile. Please try again.");
      setIsCreating(false);
    }
  };

  const handleLogout = async () => {
    googleLogout();
    clearGoogleAuthDetails();
    // The Google sign-in established the server session too, so leaving one
    // and not the other leaves an account behind that nothing here mentions.
    try {
      const { signOutOfServer } = await import("@/lib/serverSync/api");
      const { forgetAudioCapability } =
        await import("@/lib/serverAudio/transfer");
      await signOutOfServer();
      forgetAudioCapability();
    } catch (error) {
      console.warn("Could not end the server session:", error);
    }
  };

  const connectToFolderById = async (folderId: string) => {
    setConnectError(null);
    setIsConnecting(true);
    try {
      const outcome = await connectByFolderId(folderId, {
        readOnly: shareConnectReadOnly,
        onProgress: (p) =>
          setAudioDownloadProgress({
            current: p.processedFiles,
            total: p.totalFiles,
          }),
      });

      setConnectSuccess(
        outcome.kind === "already-connected"
          ? `"${outcome.name}" is already connected.`
          : `"${outcome.name}" connected successfully.`,
      );
      setShareConnectReadOnly(false);
    } catch (error) {
      console.error("Failed to connect to shared profile:", error);
      setConnectSuccess(null);
      setConnectError(
        error instanceof Error
          ? error.message
          : "Failed to connect to shared profile.",
      );
    } finally {
      setIsConnecting(false);
    }
  };

  // Load drive-picker web component (client-side only — uses HTMLElement)
  useEffect(() => {
    import("@googleworkspace/drive-picker-element");
  }, []);

  // Wire Picker events and show picker when showDrivePicker becomes true
  useEffect(() => {
    if (!showDrivePicker) return;
    const el = drivePickerRef.current;
    if (!el) return;
    (el as HTMLElement & { visible: boolean }).visible = true;
    const onPicked = (e: Event) => {
      const docs = (e as CustomEvent).detail?.docs;
      const doc = docs?.[0];
      setShowDrivePicker(false);
      if (doc?.id) connectToFolderById(doc.id);
    };
    const onCanceled = () => {
      setShowDrivePicker(false);
      setIsConnecting(false);
    };
    el.addEventListener("picker:picked", onPicked);
    el.addEventListener("picker:canceled", onCanceled);
    return () => {
      el.removeEventListener("picker:picked", onPicked);
      el.removeEventListener("picker:canceled", onCanceled);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrivePicker]);

  const handleConnectFromUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnectError(null);

    // A server share link is a link to this app, and `/server/open` already
    // knows how to honour one. Sending the user there beats telling them this
    // box only understands the other kind of link — which is what it did, in
    // a field whose placeholder said "share link" without qualification.
    const serverShare = parseServerShareUrl(shareUrl);
    if (serverShare) {
      router.push(
        `/server/open?id=${encodeURIComponent(serverShare.id)}&token=${encodeURIComponent(serverShare.token)}`,
      );
      return;
    }

    const fileMatch = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    const folderMatch = shareUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    const fileId = fileMatch
      ? fileMatch[1]
      : folderMatch
        ? null
        : shareUrl.trim();
    const folderId = folderMatch ? folderMatch[1] : null;

    if (!fileId && !folderId) {
      setConnectError(
        "That doesn't look like a Google Drive share link or an ImpAmp share link.",
      );
      return;
    }

    setIsConnecting(true);
    try {
      if (folderId) {
        await connectToFolderById(folderId);
        setShareUrl("");
        return;
      }

      // File link: try authenticated first, then public proxy fallback
      let syncData: ProfileSyncData | null = null;
      let forceReadOnly = false;
      try {
        syncData = await downloadDriveFile(fileId!);
      } catch (err) {
        if (err instanceof Error && err.message === "DRIVE_403") {
          // syncData stays null; fall through to proxy below
        } else {
          throw err;
        }
      }

      // If no data (404/scope-invisible file or DRIVE_403), try public proxy
      if (!syncData) {
        const proxyResponse = await fetchWithTimeout(
          `/api/drive/public-file?id=${encodeURIComponent(fileId!)}`,
        );
        if (proxyResponse.ok) {
          syncData = await proxyResponse.json();
          forceReadOnly = true; // public proxy = can't write back
        } else {
          const proxyError = (await proxyResponse.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            proxyError.error ||
              'This file is not publicly accessible. Only profiles shared with "anyone with the link" can be connected via URL — for privately shared profiles, ask to be invited and use "Browse shared profiles…" instead.',
          );
        }
      }

      // Already downloaded, by whichever of the two routes worked, so this
      // enters the shared path at the point after the download — the
      // validation and the already-connected check still apply.
      const outcome = await connectWithSyncData(
        syncData,
        { googleDriveFileId: fileId! },
        {
          readOnly: forceReadOnly || shareConnectReadOnly,
          onProgress: (p) =>
            setAudioDownloadProgress({
              current: p.processedFiles,
              total: p.totalFiles,
            }),
        },
      );

      setConnectSuccess(
        outcome.kind === "already-connected"
          ? `"${outcome.name}" is already connected.`
          : `"${outcome.name}" connected successfully.`,
      );
      setShareUrl("");
      setShareConnectReadOnly(false);
    } catch (error) {
      console.error("Failed to connect to shared profile:", error);
      setConnectSuccess(null);
      setConnectError(
        error instanceof Error
          ? error.message
          : "Failed to connect to shared profile.",
      );
    } finally {
      setIsConnecting(false);
    }
  };

  // Orphan cleanup handlers
  const handleScanOrphans = async () => {
    setIsScanningOrphans(true);
    setOrphanScanResult(null);
    setOrphanCleanupResult(null);

    try {
      const { findOrphanedAudioFiles } = await import("@/lib/db");
      const result = await findOrphanedAudioFiles();
      setOrphanScanResult(result);
    } catch (error) {
      console.error("Failed to scan for orphaned audio files:", error);
      // You could add error handling here if needed
    } finally {
      setIsScanningOrphans(false);
    }
  };

  const handleCleanupOrphans = async () => {
    setIsCleaningOrphans(true);
    setOrphanCleanupResult(null);

    try {
      const { cleanupOrphanedAudioFiles } = await import("@/lib/db");
      const result = await cleanupOrphanedAudioFiles();
      setOrphanCleanupResult(result);

      // Refresh scan results after cleanup
      if (result.deletedCount > 0) {
        setTimeout(() => {
          handleScanOrphans();
        }, 500);
      }
    } catch (error) {
      console.error("Failed to cleanup orphaned audio files:", error);
      setOrphanCleanupResult({
        deletedCount: 0,
        cacheEntriesCleared: 0,
        errors: [
          `Failed to cleanup: ${error instanceof Error ? error.message : error}`,
        ],
      });
    } finally {
      setIsCleaningOrphans(false);
    }
  };

  // Missing audio files handlers
  const handleScanMissing = async () => {
    setIsScanningMissing(true);
    setMissingScanResult(null);
    setReplacingIds(new Set());
    setReplacedIds(new Set());
    try {
      const { findMissingAudioFiles } = await import("@/lib/db");
      const result = await findMissingAudioFiles();
      setMissingScanResult(result);
    } catch (error) {
      console.error("Failed to scan for missing audio files:", error);
    } finally {
      setIsScanningMissing(false);
    }
  };

  const handleReplaceMissingFile = async (
    entry: MissingAudioFile,
    file: File,
  ) => {
    const key = `${entry.profileId}-${entry.bankId}-${entry.padIndex}-${entry.missingAudioFileId}`;
    setReplacingIds((prev) => new Set(prev).add(key));
    try {
      const { replaceMissingAudioFile } = await import("@/lib/db");
      await replaceMissingAudioFile(
        entry.profileId,
        entry.bankId,
        entry.padIndex,
        entry.missingAudioFileId,
        file,
      );
      setReplacedIds((prev) => new Set(prev).add(key));
    } catch (error) {
      console.error("Failed to replace missing audio file:", error);
    } finally {
      setReplacingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleRepairDriveAudio = async () => {
    setIsRepairingDriveAudio(true);
    setDriveAudioRepairResult(null);
    setDriveAudioRepairProgress(null);

    const driveProfiles = profiles.filter(
      (p) => p.syncType === "googleDrive" && p.googleDriveFileId,
    );
    setDriveAudioRepairProgress({ current: 0, total: driveProfiles.length });

    let totalChecked = 0;
    let totalUploaded = 0;
    const allErrors: string[] = [];

    for (let i = 0; i < driveProfiles.length; i++) {
      const profile = driveProfiles[i];
      setDriveAudioRepairProgress({
        current: i + 1,
        total: driveProfiles.length,
      });
      try {
        const result = await repairDriveAudio(
          profile.id!,
          profile.googleDriveFolderId ?? undefined,
        );
        totalChecked += result.checked;
        totalUploaded += result.uploaded;
        allErrors.push(...result.errors.map((e) => `[${profile.name}] ${e}`));
      } catch (err) {
        allErrors.push(
          `[${profile.name}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    setDriveAudioRepairResult({
      profilesChecked: driveProfiles.length,
      filesChecked: totalChecked,
      filesUploaded: totalUploaded,
      errors: allErrors,
    });
    setDriveAudioRepairProgress(null);
    setIsRepairingDriveAudio(false);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Profile Manager
          </h2>
          <button
            onClick={closeProfileManager}
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
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
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="px-6 flex space-x-4">
            <button
              onClick={() => setActiveTab("profiles")}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === "profiles"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Profiles
            </button>
            <button
              onClick={() => setActiveTab("import-export")}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === "import-export"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Import / Export
            </button>
            <button
              onClick={() => setActiveTab("maintenance")}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === "maintenance"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Maintenance
            </button>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "profiles" && (
            <div>
              {/* Existing Profiles */}
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Your Profiles
              </h3>

              {profiles.length === 0 ? (
                <div className="text-gray-500 dark:text-gray-400 italic">
                  No profiles found.
                </div>
              ) : (
                <div className="space-y-4">
                  {profiles.map((profile) => (
                    <ProfileCard
                      key={profile.id}
                      profile={profile}
                      isActive={profile.id === activeProfileId}
                    />
                  ))}
                </div>
              )}

              {/* Create New Profile */}
              <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Create New Profile
                </h3>

                <form onSubmit={handleCreateProfile} className="space-y-4">
                  <div>
                    <label
                      htmlFor="profileName"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Profile Name
                    </label>
                    <input
                      id="profileName"
                      type="text"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                      placeholder="Enter profile name"
                      required
                    />
                  </div>

                  <div>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className={`px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors ${
                        isCreating ? "opacity-70 cursor-not-allowed" : ""
                      }`}
                    >
                      {isCreating ? "Creating..." : "Create Profile"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {activeTab === "import-export" && (
            <div>
              {/* Export Section - Multi-Select */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Export Profiles
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Select one or more profiles below to export their
                  configurations to a single file.
                </p>

                {/* Multi-Select List */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700 max-h-60 overflow-y-auto mb-4">
                  <h4 className="text-md font-medium text-gray-800 dark:text-gray-200 mb-3">
                    Select Profiles to Export:
                  </h4>
                  {profiles.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      No profiles available to export.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {profiles.map((profile) => (
                        <div key={profile.id} className="flex items-center">
                          <input
                            id={`export-profile-${profile.id}`}
                            type="checkbox"
                            checked={exportSelectionIds.has(profile.id!)}
                            onChange={(e) =>
                              handleExportSelectChange(
                                profile.id!,
                                e.target.checked,
                              )
                            }
                            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                          />
                          <label
                            htmlFor={`export-profile-${profile.id}`}
                            className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
                          >
                            {profile.name}{" "}
                            {profile.id === activeProfileId ? "(Active)" : ""}
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Export Selected Button */}
                <button
                  onClick={async () => {
                    if (exportSelectionIds.size === 0) {
                      alert("Please select at least one profile to export.");
                      return;
                    }
                    try {
                      setIsExporting(true);
                      const success = await exportMultipleProfilesToZip(
                        Array.from(exportSelectionIds),
                        setExportProgress,
                      );
                      if (success) {
                        setExportSelectionIds(new Set()); // Clear selection after export
                      }
                      // success === false with no throw means the user
                      // cancelled the save dialog — keep the selection.
                    } catch (error) {
                      console.error(
                        "Failed to export selected profiles:",
                        error,
                      );
                      alert(
                        "Failed to export selected profiles. Please try again.",
                      );
                    } finally {
                      setIsExporting(false);
                      setExportProgress(null);
                    }
                  }}
                  disabled={isExporting || exportSelectionIds.size === 0}
                  className={`px-4 py-2 ${
                    exportSelectionIds.size > 0
                      ? "bg-green-500 text-white hover:bg-green-600"
                      : "bg-gray-200 text-gray-500"
                  } rounded-md transition-colors ${
                    isExporting || exportSelectionIds.size === 0
                      ? "cursor-not-allowed"
                      : ""
                  }`}
                >
                  {isExporting
                    ? "Exporting..."
                    : `Export Selected (${exportSelectionIds.size})`}
                </button>

                {isExporting && exportProgress && (
                  <TransferProgressBar
                    progress={exportProgress}
                    verb="Exporting"
                  />
                )}
              </section>

              {/* Import Profile Section */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Import Profile
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Import a previously exported profile configuration file.
                </p>

                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <input
                    type="file"
                    ref={fileInputRef}
                    data-testid="import-profile-file-input"
                    className="hidden"
                    accept=".iaz,.json,.iajson"
                    onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                      setImportError(null);
                      setImportSuccess(null);

                      const file = e.target.files?.[0];
                      if (!file) return;

                      try {
                        setIsImporting(true);

                        const { detectImportFormat } =
                          await import("@/lib/importExport");
                        const format = await detectImportFormat(file);

                        if (format === "zip") {
                          // Handles both single- and multi-profile archives;
                          // audio streams straight from the file to IndexedDB.
                          const results = await importProfilesFromZip(
                            file,
                            setImportProgress,
                          );
                          const successes = results.filter(
                            (r) => typeof r.result === "number",
                          ).length;
                          const failures = results.length - successes;
                          if (failures > 0) {
                            const failedNames = results
                              .filter((r) => r.result instanceof Error)
                              .map((r) => r.profileName)
                              .join(", ");
                            setImportError(
                              `Import complete: ${successes} succeeded, ${failures} failed. Failed profiles: ${failedNames}`,
                            );
                          } else if (successes === 1) {
                            setImportSuccess(
                              `Profile "${results[0].profileName}" imported successfully!`,
                            );
                          } else {
                            setImportSuccess(
                              `Import complete: ${successes} profiles imported successfully.`,
                            );
                          }
                        } else if (format === "json-too-large") {
                          setImportError(
                            "This JSON export is too large for the browser to import. " +
                              "Please re-export it as a .iaz archive (the current export format), " +
                              "which supports files of any size.",
                          );
                        } else if (format === "json-v1-multi") {
                          const content = await file.text();
                          const results =
                            await importMultipleProfilesFromJSON(content);
                          const successes = results.filter(
                            (r: { result: number | Error }) =>
                              typeof r.result === "number",
                          ).length;
                          const failures = results.length - successes;
                          let message = `Multi-profile import complete: ${successes} succeeded`;
                          if (failures > 0) {
                            message += `, ${failures} failed.`;
                            const failedNames = results
                              .filter(
                                (r: { result: number | Error }) =>
                                  r.result instanceof Error,
                              )
                              .map(
                                (r: { profileName: string }) => r.profileName,
                              )
                              .join(", ");
                            message += ` Failed profiles: ${failedNames}`;
                            setImportError(message);
                          } else {
                            setImportSuccess(message);
                          }
                        } else if (format === "json-v2-single") {
                          const content = await file.text();
                          const profileId =
                            await importProfileFromJSON(content);
                          setImportSuccess(
                            `Profile imported successfully! (New ID: ${profileId})`,
                          );
                        } else if (format === "impamp2-legacy") {
                          const content = await file.text();
                          const profileId =
                            await importProfileFromImpamp2JSON(content);
                          setImportSuccess(
                            `Impamp2 profile imported successfully! (New ID: ${profileId})`,
                          );
                        } else {
                          setImportError(
                            "Failed to import: Unrecognized or invalid file format.",
                          );
                        }
                      } catch (error) {
                        console.error("Error during import processing:", error);
                        const msg =
                          error instanceof Error
                            ? error.message
                            : "An unknown error occurred during import.";
                        setImportError(`Failed to import profile: ${msg}`);
                      } finally {
                        setIsImporting(false);
                        setImportProgress(null);
                        if (fileInputRef.current) {
                          fileInputRef.current.value = "";
                        }
                      }
                    }}
                  />

                  {importError && (
                    <div className="mb-4 p-2 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 rounded border border-red-200 dark:border-red-800">
                      {importError}
                    </div>
                  )}

                  {importSuccess && (
                    <div className="mb-4 p-2 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 rounded border border-green-200 dark:border-green-800">
                      {importSuccess}
                    </div>
                  )}

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isImporting}
                    className={`px-4 py-2 ${
                      isImporting
                        ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                        : "bg-blue-500 text-white hover:bg-blue-600"
                    } rounded-md transition-colors`}
                  >
                    {isImporting ? "Importing..." : "Select File to Import"}
                  </button>

                  {isImporting && importProgress && (
                    <TransferProgressBar
                      progress={importProgress}
                      verb="Importing"
                    />
                  )}

                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Only import files that were previously exported from ImpAmp2
                    or ImpAmp3.
                  </p>
                </div>
              </section>

              {/* Accounts section */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Accounts
                </h3>

                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700 space-y-4">
                  {/* Sign in / user row */}
                  <div className="flex items-center space-x-4">
                    {!isGoogleSignedIn ? (
                      <>
                        <button
                          onClick={() => googleLogin()}
                          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
                        >
                          Sign in with Google
                        </button>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          Sign in to enable Drive features.
                        </p>
                      </>
                    ) : (
                      <>
                        {googleUser?.picture && (
                          <Image
                            src={googleUser.picture}
                            alt="User profile"
                            width={40}
                            height={40}
                            className="rounded-full"
                          />
                        )}
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {googleUser?.name || "Signed In"}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {googleUser?.email}
                          </p>
                        </div>
                        <button
                          onClick={handleLogout}
                          className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-md hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
                        >
                          Sign Out
                        </button>
                      </>
                    )}
                  </div>

                  {googleApiError && !isGoogleSignedIn && (
                    <p className="text-xs text-red-600 dark:text-red-400">
                      Auth Error: {googleApiError}
                    </p>
                  )}

                  {/*
                    One Google sign-in also establishes a session on this
                    ImpAmp server, so the account exists whether or not anyone
                    was told about it. Now they are told, and can leave it.
                  */}
                  <div className="border-t border-gray-200 pt-4 dark:border-gray-700">
                    <h4 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">
                      ImpAmp server
                    </h4>
                    <ServerAccountPanel />
                  </div>

                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Where each profile syncs is set on its own card in the{" "}
                    <button
                      onClick={() => setActiveTab("profiles")}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Profiles tab
                    </button>
                    , behind its sync status.
                  </p>

                  {/*
                    Outside the Google gate on purpose: the list covers both
                    sources, and a server account with no Google sign-in is a
                    perfectly ordinary state. Gating it on Drive is what hid
                    server profiles from everyone in the first place.
                  */}
                  <div className="border-t border-gray-200 pt-4 dark:border-gray-700">
                    <ConnectProfileList
                      onConnected={(name) =>
                        setConnectSuccess(`"${name}" connected successfully.`)
                      }
                    />
                  </div>

                  {isGoogleSignedIn && (
                    <>
                      {/* ── Connect to shared profile ── */}
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Connect to shared profile
                        </h4>
                        <div className="space-y-3">
                          {/* Picker option — for privately shared profiles */}
                          <div className="flex items-center gap-3">
                            <button
                              disabled={isConnecting}
                              onClick={() => {
                                setConnectError(null);
                                setConnectSuccess(null);
                                setShowDrivePicker(true);
                              }}
                              className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50"
                            >
                              {isConnecting
                                ? audioDownloadProgress
                                  ? `Downloading audio (${audioDownloadProgress.current}/${audioDownloadProgress.total})…`
                                  : "Connecting…"
                                : "Browse shared profiles…"}
                            </button>
                            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={shareConnectReadOnly}
                                onChange={(e) =>
                                  setShareConnectReadOnly(e.target.checked)
                                }
                                className="rounded"
                              />
                              Read-only
                            </label>
                          </div>
                          {showDrivePicker && (
                            <drive-picker
                              ref={drivePickerRef}
                              app-id={process.env.NEXT_PUBLIC_GOOGLE_APP_ID}
                              developer-key={
                                process.env.NEXT_PUBLIC_GOOGLE_API_KEY
                              }
                              oauth-token={googleAccessToken ?? undefined}
                              max-items={1}
                            >
                              <drive-picker-docs-view
                                view-id="SHARED_WITH_ME"
                                include-folders="true"
                                mime-types="application/vnd.google-apps.folder"
                              />
                            </drive-picker>
                          )}
                          {/* URL option — for public "anyone with link" profiles */}
                          <form
                            onSubmit={handleConnectFromUrl}
                            className="flex gap-2"
                          >
                            <input
                              type="text"
                              value={shareUrl}
                              onChange={(e) => {
                                setShareUrl(e.target.value);
                                setConnectSuccess(null);
                                setConnectError(null);
                              }}
                              placeholder="Or paste a share link (Drive or ImpAmp)…"
                              className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
                            />
                            <button
                              type="submit"
                              disabled={isConnecting || !shareUrl}
                              className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50"
                            >
                              {isConnecting ? "Connecting…" : "Connect"}
                            </button>
                          </form>
                          {/* Open With option — via Google Drive right-click */}
                          <p className="text-xs text-gray-400 dark:text-gray-500">
                            <span className="font-medium text-gray-500 dark:text-gray-400">
                              Tip:
                            </span>{" "}
                            In Google Drive, right-click the shared folder and
                            choose{" "}
                            <span className="font-medium">
                              Open with → ImpAmp3
                            </span>
                            .
                          </p>
                          {connectError && (
                            <p className="text-xs text-red-600 dark:text-red-400">
                              {connectError}
                            </p>
                          )}
                          {connectSuccess && (
                            <p className="text-xs text-green-600 dark:text-green-400">
                              {connectSuccess}
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === "maintenance" && (
            <div>
              {/* Orphaned Audio Files Section */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Orphaned Audio Files
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Scan for and clean up audio files that are no longer
                  referenced by any sound pads. These files take up storage
                  space but are not being used.
                </p>

                <div className="space-y-4">
                  {/* Scan Button */}
                  <div>
                    <button
                      onClick={handleScanOrphans}
                      disabled={isScanningOrphans || isCleaningOrphans}
                      className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {isScanningOrphans ? (
                        <>
                          <svg
                            className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                            xmlns="http://www.w3.org/2000/svg"
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
                            ></circle>
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path>
                          </svg>
                          Scanning...
                        </>
                      ) : (
                        "Scan for Orphaned Files"
                      )}
                    </button>
                  </div>

                  {/* Scan Results */}
                  {orphanScanResult && (
                    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                      <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                        Scan Results
                      </h4>
                      <div className="space-y-2 text-sm">
                        <p className="text-gray-600 dark:text-gray-300">
                          Total audio files:{" "}
                          <span className="font-medium">
                            {orphanScanResult.totalAudioFiles}
                          </span>
                        </p>
                        <p className="text-green-600 dark:text-green-400">
                          Referenced files:{" "}
                          <span className="font-medium">
                            {orphanScanResult.referencedIds.size}
                          </span>
                        </p>
                        <p
                          className={`font-medium ${
                            orphanScanResult.orphanedIds.size > 0
                              ? "text-orange-600 dark:text-orange-400"
                              : "text-green-600 dark:text-green-400"
                          }`}
                        >
                          Orphaned files:{" "}
                          <span className="font-medium">
                            {orphanScanResult.orphanedIds.size}
                          </span>
                        </p>

                        {orphanScanResult.orphanedIds.size > 0 && (
                          <div className="mt-4">
                            <button
                              onClick={handleCleanupOrphans}
                              disabled={isCleaningOrphans || isScanningOrphans}
                              className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                            >
                              {isCleaningOrphans ? (
                                <>
                                  <svg
                                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                                    xmlns="http://www.w3.org/2000/svg"
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
                                    ></circle>
                                    <path
                                      className="opacity-75"
                                      fill="currentColor"
                                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                    ></path>
                                  </svg>
                                  Cleaning up...
                                </>
                              ) : (
                                `Delete ${orphanScanResult.orphanedIds.size} Orphaned Files`
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Cleanup Results */}
                  {orphanCleanupResult && (
                    <div
                      className={`rounded-lg p-4 ${
                        orphanCleanupResult.errors.length > 0
                          ? "bg-yellow-50 dark:bg-yellow-900/20"
                          : "bg-green-50 dark:bg-green-900/20"
                      }`}
                    >
                      <h4
                        className={`font-medium mb-2 ${
                          orphanCleanupResult.errors.length > 0
                            ? "text-yellow-800 dark:text-yellow-200"
                            : "text-green-800 dark:text-green-200"
                        }`}
                      >
                        Cleanup Results
                      </h4>
                      <div className="space-y-2 text-sm">
                        <p
                          className={
                            orphanCleanupResult.errors.length > 0
                              ? "text-yellow-700 dark:text-yellow-300"
                              : "text-green-700 dark:text-green-300"
                          }
                        >
                          Files deleted:{" "}
                          <span className="font-medium">
                            {orphanCleanupResult.deletedCount}
                          </span>
                        </p>
                        <p
                          className={
                            orphanCleanupResult.errors.length > 0
                              ? "text-yellow-700 dark:text-yellow-300"
                              : "text-green-700 dark:text-green-300"
                          }
                        >
                          Cache entries cleared:{" "}
                          <span className="font-medium">
                            {orphanCleanupResult.cacheEntriesCleared}
                          </span>
                        </p>

                        {orphanCleanupResult.errors.length > 0 && (
                          <div className="mt-2">
                            <p className="text-yellow-800 dark:text-yellow-200 font-medium">
                              Errors encountered:
                            </p>
                            <ul className="mt-1 space-y-1 text-yellow-700 dark:text-yellow-300">
                              {orphanCleanupResult.errors.map(
                                (error, index) => (
                                  <li key={index} className="text-xs">
                                    • {error}
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                        )}

                        {orphanCleanupResult.deletedCount > 0 &&
                          orphanCleanupResult.errors.length === 0 && (
                            <p className="text-green-700 dark:text-green-300 font-medium mt-2">
                              ✅ Cleanup completed successfully!
                            </p>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Missing Audio Files Section */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Missing Audio Files
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Scan for pads that reference audio files no longer stored in
                  this browser. You can supply a replacement file for each
                  missing reference.
                </p>

                <div className="space-y-4">
                  <div>
                    <button
                      onClick={handleScanMissing}
                      disabled={isScanningMissing}
                      className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {isScanningMissing ? (
                        <>
                          <svg
                            className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                            xmlns="http://www.w3.org/2000/svg"
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
                            ></circle>
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            ></path>
                          </svg>
                          Scanning...
                        </>
                      ) : (
                        "Scan for Missing Audio Files"
                      )}
                    </button>
                  </div>

                  {missingScanResult !== null && (
                    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                      {missingScanResult.length === 0 ? (
                        <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                          No missing audio files found.
                        </p>
                      ) : (
                        <>
                          <p className="text-sm text-orange-600 dark:text-orange-400 font-medium mb-4">
                            {missingScanResult.length} missing audio file
                            {missingScanResult.length !== 1 ? "s" : ""} found
                          </p>
                          {Array.from(
                            new Map(
                              missingScanResult.map((e) => [
                                e.profileId,
                                e.profileName,
                              ]),
                            ).entries(),
                          ).map(([profileId, profileName]) => (
                            <div key={profileId} className="mb-4 last:mb-0">
                              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                {profileName}
                              </p>
                              <div className="space-y-2">
                                {missingScanResult
                                  .filter((e) => e.profileId === profileId)
                                  .map((entry) => {
                                    const key = `${entry.profileId}-${entry.bankId}-${entry.padIndex}-${entry.missingAudioFileId}`;
                                    const isReplacing = replacingIds.has(key);
                                    const isReplaced = replacedIds.has(key);
                                    return (
                                      <div
                                        key={key}
                                        className="flex items-center justify-between gap-4 text-sm bg-white dark:bg-gray-700 rounded px-3 py-2"
                                      >
                                        <span className="text-gray-700 dark:text-gray-200">
                                          Bank {entry.bankName} &rsaquo;{" "}
                                          {entry.padName
                                            ? `"${entry.padName}"`
                                            : `Pad ${entry.padIndex + 1}`}
                                        </span>
                                        {isReplaced ? (
                                          <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">
                                            Replaced
                                          </span>
                                        ) : (
                                          <label className="shrink-0">
                                            <input
                                              type="file"
                                              accept="audio/*"
                                              className="sr-only"
                                              disabled={isReplacing}
                                              onChange={(e) => {
                                                const file =
                                                  e.target.files?.[0];
                                                if (file)
                                                  handleReplaceMissingFile(
                                                    entry,
                                                    file,
                                                  );
                                              }}
                                            />
                                            <span
                                              className={`cursor-pointer px-3 py-1 text-xs rounded border transition-colors ${
                                                isReplacing
                                                  ? "border-gray-300 text-gray-400 cursor-not-allowed"
                                                  : "border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                              }`}
                                            >
                                              {isReplacing
                                                ? "Replacing…"
                                                : "Choose replacement…"}
                                            </span>
                                          </label>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>

              {/* Google Drive Audio Repair Section */}
              {isGoogleSignedIn && (
                <section className="mb-8">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                    Repair Google Drive Audio Files
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                    Scans all Drive-linked profiles and re-uploads any audio
                    files that are missing from Google Drive (deleted or never
                    uploaded).
                  </p>

                  <div className="space-y-4">
                    <div>
                      <button
                        onClick={handleRepairDriveAudio}
                        disabled={isRepairingDriveAudio}
                        className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                      >
                        {isRepairingDriveAudio ? (
                          <>
                            <svg
                              className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                              xmlns="http://www.w3.org/2000/svg"
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
                              ></circle>
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                              ></path>
                            </svg>
                            {driveAudioRepairProgress
                              ? `Checking profile ${driveAudioRepairProgress.current} of ${driveAudioRepairProgress.total}…`
                              : "Starting…"}
                          </>
                        ) : (
                          "Scan & Repair Drive Audio"
                        )}
                      </button>
                    </div>

                    {driveAudioRepairResult && (
                      <div
                        className={`rounded-lg p-4 ${
                          driveAudioRepairResult.errors.length > 0
                            ? "bg-yellow-50 dark:bg-yellow-900/20"
                            : "bg-green-50 dark:bg-green-900/20"
                        }`}
                      >
                        <h4
                          className={`font-medium mb-2 ${
                            driveAudioRepairResult.errors.length > 0
                              ? "text-yellow-800 dark:text-yellow-200"
                              : "text-green-800 dark:text-green-200"
                          }`}
                        >
                          Repair Results
                        </h4>
                        <div className="space-y-2 text-sm">
                          <p className="text-gray-600 dark:text-gray-300">
                            Profiles checked:{" "}
                            <span className="font-medium">
                              {driveAudioRepairResult.profilesChecked}
                            </span>
                          </p>
                          <p className="text-gray-600 dark:text-gray-300">
                            Files verified:{" "}
                            <span className="font-medium">
                              {driveAudioRepairResult.filesChecked}
                            </span>
                          </p>
                          <p
                            className={`font-medium ${
                              driveAudioRepairResult.filesUploaded > 0
                                ? "text-orange-600 dark:text-orange-400"
                                : "text-green-600 dark:text-green-400"
                            }`}
                          >
                            Files re-uploaded:{" "}
                            <span className="font-medium">
                              {driveAudioRepairResult.filesUploaded}
                            </span>
                          </p>

                          {driveAudioRepairResult.errors.length > 0 && (
                            <div className="mt-2">
                              <p className="text-yellow-800 dark:text-yellow-200 font-medium">
                                Errors encountered:
                              </p>
                              <ul className="mt-1 space-y-1 text-yellow-700 dark:text-yellow-300">
                                {driveAudioRepairResult.errors.map(
                                  (error, index) => (
                                    <li key={index} className="text-xs">
                                      • {error}
                                    </li>
                                  ),
                                )}
                              </ul>
                            </div>
                          )}

                          {driveAudioRepairResult.filesUploaded === 0 &&
                            driveAudioRepairResult.errors.length === 0 && (
                              <p className="text-green-700 dark:text-green-300 font-medium mt-2">
                                ✅ All audio files are present in Google Drive!
                              </p>
                            )}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button
            onClick={closeProfileManager}
            className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
