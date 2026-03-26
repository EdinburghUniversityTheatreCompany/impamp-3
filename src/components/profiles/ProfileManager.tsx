"use client";

import { useState, useEffect, useRef, ChangeEvent } from "react";
import Image from "next/image";
import { useProfileStore, GoogleUserInfo } from "@/store/profileStore";
import { SyncType, Profile, PadConfiguration, PageMetadata } from "@/lib/db";
import ProfileCard from "./ProfileCard";
import { useGoogleLogin, googleLogout } from "@react-oauth/google";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { useModal } from "@/hooks/modal/useModal";
import { ModalType } from "@/components/modals/modalRegistry";
import { ProfileSyncData } from "@/lib/syncUtils";

export default function ProfileManager() {
  const {
    profiles,
    activeProfileId,
    isProfileManagerOpen,
    closeProfileManager,
    createProfile,
    updateProfile,
    importProfileFromJSON,
    importProfileFromImpamp2JSON,
    importMultipleProfilesFromJSON,
    exportMultipleProfilesToJSON,
    isGoogleSignedIn,
    googleUser,
    setGoogleAuthDetails,
    clearGoogleAuthDetails,
  } = useProfileStore();

  const { openLazyModal, closeModal } = useModal();

  // State management
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileSyncType, setNewProfileSyncType] =
    useState<SyncType>("local");
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "profiles" | "import-export" | "maintenance"
  >("profiles");

  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [exportSelectionIds, setExportSelectionIds] = useState<Set<number>>(
    new Set(),
  ); // State for export selection

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

  // Connect to shared profile state
  const [shareUrl, setShareUrl] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

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
  // Interface for drive files with additional metadata
  interface DriveFile {
    id: string;
    name: string;
    modifiedTime?: string;
    size?: number;
    iconLink?: string;
    thumbnailLink?: string;
  }

  // State for Google Drive file handling
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveFilesLoaded, setDriveFilesLoaded] = useState(false);
  const [driveActionStatus, setDriveActionStatus] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle");
  const [driveActionError, setDriveActionError] = useState<string | null>(null);
  const [importingFileId, setImportingFileId] = useState<string | null>(null);
  const [importedFileId, setImportedFileId] = useState<string | null>(null); // tracks last successfully connected file
  const [driveConnectReadOnly, setDriveConnectReadOnly] = useState(false);
  const [shareConnectReadOnly, setShareConnectReadOnly] = useState(false);

  // Hooks
  const {
    downloadDriveFile,
    listAppFiles,
    syncStatus: driveHookStatus,
    error: driveHookError,
    conflicts: driveHookConflicts,
    conflictData: driveHookConflictData,
    applyConflictResolution,
  } = useGoogleDriveSync();

  const googleLogin = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      console.log("Google Login Success (hook):", tokenResponse);
      setGoogleApiError(null);
      const accessToken = tokenResponse.access_token;
      try {
        const userInfoResponse = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        if (!userInfoResponse.ok) {
          throw new Error(
            `Failed to fetch user info: ${userInfoResponse.statusText}`,
          );
        }
        const userInfo: GoogleUserInfo = await userInfoResponse.json();
        console.log("Fetched Google User Info:", userInfo);

        // Calculate token expiration time (usually 1 hour from now for Google)
        const expiresAt = Date.now() + 3600 * 1000; // 1 hour in milliseconds

        // Get refresh token if available - accessing through type assertion since it's not in the type definitions
        const refreshToken =
          ((tokenResponse as Record<string, unknown>)
            .refresh_token as string) || null;

        // Store Google auth details with refresh token and expiration
        setGoogleAuthDetails(userInfo, accessToken, refreshToken, expiresAt);

        // Log authentication success to help with testing
        console.log(
          "Google authentication successful and stored in profile store",
        );
        console.log("Authentication should now persist between page reloads");
      } catch (error) {
        console.error("Error fetching Google user info:", error);
        setGoogleApiError(
          error instanceof Error
            ? error.message
            : "Failed to fetch user details after login.",
        );
      }
    },
    onError: (errorResponse) => {
      console.error("Google Login Failed (hook):", errorResponse);
      setGoogleApiError(
        `Login failed: ${errorResponse.error_description || errorResponse.error || "Unknown error"}`,
      );
      clearGoogleAuthDetails();
    },
    scope: "https://www.googleapis.com/auth/drive.file",
  });

  // Sync hook status/error to local state
  useEffect(() => {
    if (driveHookStatus === "error" && driveHookError) {
      setDriveActionStatus("error");
      setDriveActionError(driveHookError);
    }
  }, [driveHookStatus, driveHookError]);

  // Open conflict resolution modal when conflicts are detected
  useEffect(() => {
    if (
      driveHookStatus === "conflict" &&
      driveHookConflictData &&
      driveHookConflicts.length > 0
    ) {
      openLazyModal({
        title: "Sync Conflict Resolution",
        modalType: ModalType.CONFLICT_RESOLUTION,
        modalProps: {
          conflicts: driveHookConflicts,
          conflictData: driveHookConflictData,
          onResolve: (resolvedData: ProfileSyncData) => {
            applyConflictResolution(
              resolvedData,
              driveHookConflictData.fileId,
              driveHookConflictData.local.profile.id!,
            );
            closeModal();
          },
          onCancel: () => {
            console.log("Conflict resolution cancelled by user.");
            setDriveActionStatus("idle");
            setDriveActionError(null);
            closeModal();
          },
        },
        showConfirmButton: false,
        showCancelButton: false,
        size: "xl",
      });
    }
  }, [
    driveHookStatus,
    driveHookConflictData,
    driveHookConflicts,
    openLazyModal,
    closeModal,
    applyConflictResolution,
    setDriveActionStatus,
    setDriveActionError,
  ]);

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
        syncType: newProfileSyncType,
      });
      setNewProfileName("");
      setNewProfileSyncType("local");
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to create profile:", error);
      alert("Failed to create profile. Please try again.");
      setIsCreating(false);
    }
  };

  const handleLogout = () => {
    googleLogout();
    clearGoogleAuthDetails();
    console.log("Logged out from Google");
  };

  // Load Drive files inline (no modal)
  const handleLoadDriveFiles = async () => {
    setDriveActionStatus("loading");
    setDriveActionError(null);
    setImportedFileId(null);

    try {
      const files = await listAppFiles();
      setDriveFiles(files);
      setDriveFilesLoaded(true);
      setDriveActionStatus("success");
    } catch (error) {
      console.error("Failed to load Drive files:", error);
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load files from Google Drive.";
      setDriveActionError(message);
      setDriveActionStatus("error");
    }
  };

  /**
   * Interface for audio file data in sync/export formats
   */
  interface AudioFileData {
    id: number;
    name: string;
    type: string;
    data: string; // Base64 encoded audio data
  }

  /**
   * Defines the structure for export format data used by importProfileFromJSON
   */
  interface ProfileExportData {
    exportVersion: number;
    exportDate: string;
    profile: Profile & { [key: string]: unknown };
    padConfigurations: PadConfiguration[];
    pageMetadata: PageMetadata[];
    audioFiles: AudioFileData[];
  }

  /**
   * Converts Google Drive sync format to profile export format
   * This is necessary because the sync format and export format are different
   */
  const convertSyncToExportFormat = (
    syncData: ProfileSyncData,
  ): ProfileExportData => {
    // Create a copy of the profile
    const profileCopy = { ...syncData.profile };

    // Create a profile object with lastBackedUpAt set to current time
    // Profile type requires lastBackedUpAt to be a number
    const profileWithoutBackupDate = {
      ...profileCopy,
      // Set lastBackedUpAt to current time instead of undefined
      lastBackedUpAt: Date.now(),
    } as Profile & { [key: string]: unknown };

    // Create export format object
    return {
      exportVersion: 2, // Use current export version
      exportDate: new Date().toISOString(),
      profile: profileWithoutBackupDate,
      padConfigurations: syncData.padConfigurations || [],
      pageMetadata: syncData.pageMetadata || [],
      audioFiles: syncData.audioFiles || [],
    };
  };

  const handleImportFromDrive = async (fileId: string, readOnly = false) => {
    setImportingFileId(fileId);
    setDriveActionStatus("loading");
    setDriveActionError(null);

    try {
      const syncData = await downloadDriveFile(fileId);

      if (syncData && syncData._syncFormatVersion === 1 && syncData.profile) {
        const exportData = convertSyncToExportFormat(syncData);
        exportData.profile = {
          ...exportData.profile,
          id: undefined,
          syncType: "googleDrive",
        };

        const profileIdsBefore = new Set(profiles.map((p) => p.id));
        await importProfileFromJSON(JSON.stringify(exportData));

        // Link the newly created profile to the Drive file for ongoing sync
        const newProfile = useProfileStore
          .getState()
          .profiles.find((p) => !profileIdsBefore.has(p.id));
        if (newProfile?.id) {
          await updateProfile(newProfile.id, {
            googleDriveFileId: fileId,
            readOnly: readOnly || undefined,
          });
        }

        console.log(
          `Successfully connected profile "${syncData.profile.name}" from Google Drive.`,
        );
        setImportedFileId(fileId);
      } else {
        console.warn("Downloaded file data:", syncData);
        throw new Error(
          "Downloaded file has unrecognized format or is not a valid profile sync file.",
        );
      }
      setDriveActionStatus("success");
    } catch (error) {
      console.error("Failed to import from Drive:", error);
      const message =
        error instanceof Error
          ? error.message
          : "Failed to import profile from Google Drive.";
      setDriveActionError(message);
      setDriveActionStatus("error");
    } finally {
      setImportingFileId(null); // Clear the loading state
    }
  };

  const handleConnectSharedProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnectError(null);

    // Extract file ID from a Drive URL, or treat the input as a raw file ID
    const match = shareUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    const fileId = match ? match[1] : shareUrl.trim();

    if (!fileId) {
      setConnectError(
        "Please enter a valid Google Drive share URL or file ID.",
      );
      return;
    }

    setIsConnecting(true);
    try {
      const syncData = await downloadDriveFile(fileId);

      if (!syncData || syncData._syncFormatVersion !== 1 || !syncData.profile) {
        throw new Error("Not a valid ImpAmp profile file.");
      }

      // Record existing profile IDs so we can identify the newly created one
      const profileIdsBefore = new Set(profiles.map((p) => p.id));

      // Convert sync format to export format and import as a new local profile
      const exportData = convertSyncToExportFormat(syncData);
      exportData.profile = {
        ...exportData.profile,
        id: undefined,
        syncType: "googleDrive",
      };
      await importProfileFromJSON(JSON.stringify(exportData));

      // Find the newly created profile and link it to the shared Drive file
      const updatedProfiles = useProfileStore.getState().profiles;
      const newProfile = updatedProfiles.find(
        (p) => !profileIdsBefore.has(p.id),
      );
      if (newProfile?.id) {
        await updateProfile(newProfile.id, {
          googleDriveFileId: fileId,
          readOnly: shareConnectReadOnly || undefined,
        });
      }

      setShareUrl("");
      setShareConnectReadOnly(false);
    } catch (error) {
      console.error("Failed to connect to shared profile:", error);
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

  if (!isProfileManagerOpen) {
    return null;
  }

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
                    <label
                      htmlFor="syncType"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Storage Type
                    </label>
                    <select
                      id="syncType"
                      value={newProfileSyncType}
                      onChange={(e) =>
                        setNewProfileSyncType(e.target.value as SyncType)
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                    >
                      <option value="local">Local Only</option>
                      <option value="googleDrive">Google Drive</option>
                    </select>
                    {newProfileSyncType === "googleDrive" && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Google Drive sync allows you to automatically
                        synchronize this profile across devices and collaborate
                        with others.
                      </p>
                    )}
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
                    if (!exportMultipleProfilesToJSON) {
                      console.error(
                        "exportMultipleProfilesToJSON function is not available in the profile store.",
                      );
                      alert("Multi-export functionality is not available.");
                      return;
                    }
                    try {
                      setIsExporting(true);
                      await exportMultipleProfilesToJSON(
                        Array.from(exportSelectionIds),
                      );
                      setIsExporting(false);
                      setExportSelectionIds(new Set()); // Clear selection after export
                    } catch (error) {
                      console.error(
                        "Failed to export selected profiles:",
                        error,
                      );
                      setIsExporting(false);
                      alert(
                        "Failed to export selected profiles. Please try again.",
                      );
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
                    accept=".json,.iajson"
                    onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                      // Reset states
                      setImportError(null);
                      setImportSuccess(null);

                      const file = e.target.files?.[0];
                      if (!file) return;

                      try {
                        setIsImporting(true);

                        // Read the file
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                          const content = event.target?.result as string;
                          if (!content) {
                            setImportError("Failed to read file content.");
                            setIsImporting(false);
                            return;
                          }

                          try {
                            const parsedData = JSON.parse(content);

                            // --- Check for Multi-Profile Format (Version 1) ---
                            if (
                              parsedData &&
                              parsedData.exportVersion === 1 &&
                              Array.isArray(parsedData.profiles)
                            ) {
                              console.log(
                                "Attempting import as multi-profile format (v1)...",
                              );
                              // Check if the function exists before calling
                              if (!importMultipleProfilesFromJSON) {
                                console.error(
                                  "importMultipleProfilesFromJSON function is not available in the profile store.",
                                );
                                throw new Error(
                                  "Multi-import functionality is not available.",
                                );
                              }
                              // Use store function
                              const results =
                                await importMultipleProfilesFromJSON(content);
                              // Add explicit types for filter/map parameters
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
                                    (r: { profileName: string }) =>
                                      r.profileName,
                                  )
                                  .join(", ");
                                message += ` Failed profiles: ${failedNames}`;
                                setImportError(message); // Show summary as error if any failed
                              } else {
                                setImportSuccess(message); // Show as success only if all succeeded
                              }
                              setIsImporting(false);

                              // --- Check for Single Profile Format (Version 2) ---
                            } else if (
                              parsedData &&
                              parsedData.exportVersion === 2 &&
                              parsedData.profile
                            ) {
                              console.log(
                                "Attempting import as current single profile format (v2)...",
                              );
                              const currentProfileId =
                                await importProfileFromJSON(content);
                              setImportSuccess(
                                `Profile imported successfully! (New ID: ${currentProfileId})`,
                              );
                              setIsImporting(false);

                              // --- Check for Legacy Impamp2 Format (heuristic check) ---
                            } else if (
                              parsedData &&
                              parsedData.pages &&
                              typeof parsedData.pages === "object" &&
                              !parsedData.exportVersion
                            ) {
                              // Heuristic: has 'pages' object, no 'exportVersion'
                              console.log(
                                "Attempting import as impamp2 format...",
                              );
                              const impamp2ProfileId =
                                await importProfileFromImpamp2JSON(content);
                              setImportSuccess(
                                `Impamp2 profile imported successfully! (New ID: ${impamp2ProfileId})`,
                              );
                              setIsImporting(false);
                            } else {
                              // --- Unrecognized format ---
                              console.error(
                                "Unrecognized file format.",
                                parsedData,
                              );
                              setImportError(
                                "Failed to import: Unrecognized or invalid file format.",
                              );
                              setIsImporting(false);
                            }
                          } catch (error) {
                            console.error(
                              "Error during import processing:",
                              error,
                            );
                            let finalErrorMessage =
                              "Failed to import profile: ";
                            if (error instanceof SyntaxError) {
                              finalErrorMessage +=
                                "Invalid JSON format in file.";
                            } else if (error instanceof Error) {
                              finalErrorMessage += error.message; // Use the specific error message
                            } else {
                              finalErrorMessage +=
                                "An unknown error occurred during import.";
                            }
                            setImportError(finalErrorMessage);
                            setIsImporting(false);
                          } finally {
                            // Reset the file input regardless of success or failure
                            if (fileInputRef.current) {
                              fileInputRef.current.value = "";
                            }
                          }
                        };

                        reader.onerror = () => {
                          setImportError("Failed to read file");
                          setIsImporting(false);
                        };

                        reader.readAsText(file);
                      } catch (error) {
                        const errorMessage =
                          error instanceof Error
                            ? error.message
                            : "An unknown error occurred";
                        setImportError(
                          `Failed to import profile: ${errorMessage}`,
                        );
                        setIsImporting(false);
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
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Only import files that were previously exported from ImpAmp2
                    or ImpAmp3.
                  </p>
                </div>
              </section>

              {/* Google Drive Integration section */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Google Drive Integration
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

                  {isGoogleSignedIn && (
                    <>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Profile sync actions (Link, Sync Now, Unlink) are on
                        individual profile cards in the{" "}
                        <button
                          onClick={() => setActiveTab("profiles")}
                          className="text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Profiles tab
                        </button>
                        .
                      </p>

                      {/* ── Connect from your Drive ── */}
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                            Connect from your Drive
                          </h4>
                          <button
                            onClick={handleLoadDriveFiles}
                            disabled={driveActionStatus === "loading"}
                            className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40 disabled:opacity-50 transition-colors"
                          >
                            {driveActionStatus === "loading"
                              ? "Loading..."
                              : driveFilesLoaded
                                ? "Refresh"
                                : "Load my Drive profiles"}
                          </button>
                        </div>

                        {driveActionStatus === "error" && driveActionError && (
                          <p className="text-xs text-red-600 dark:text-red-400 mb-2">
                            {driveActionError}
                          </p>
                        )}

                        {driveFilesLoaded &&
                          driveActionStatus === "success" && (
                            <>
                              {driveFiles.length === 0 ? (
                                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                                  No ImpAmp profile files found in your Drive.
                                </p>
                              ) : (
                                <ul className="divide-y divide-gray-200 dark:divide-gray-700 border rounded dark:border-gray-600">
                                  {driveFiles.map((file) => (
                                    <li
                                      key={file.id}
                                      className={`flex items-center px-3 py-2 gap-3 ${
                                        importedFileId === file.id
                                          ? "bg-green-50 dark:bg-green-900/20"
                                          : "hover:bg-gray-50 dark:hover:bg-gray-700"
                                      }`}
                                    >
                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                                          {file.name}
                                        </p>
                                        {file.modifiedTime && (
                                          <p className="text-xs text-gray-500 dark:text-gray-400">
                                            {new Date(
                                              file.modifiedTime,
                                            ).toLocaleString()}
                                          </p>
                                        )}
                                      </div>
                                      {importedFileId === file.id ? (
                                        <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">
                                          Connected!
                                        </span>
                                      ) : (
                                        <div className="flex items-center gap-2 shrink-0">
                                          <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                                            <input
                                              type="checkbox"
                                              checked={driveConnectReadOnly}
                                              onChange={(e) =>
                                                setDriveConnectReadOnly(
                                                  e.target.checked,
                                                )
                                              }
                                              className="rounded"
                                            />
                                            Read-only
                                          </label>
                                          <button
                                            onClick={() =>
                                              handleImportFromDrive(
                                                file.id,
                                                driveConnectReadOnly,
                                              )
                                            }
                                            disabled={
                                              importingFileId === file.id
                                            }
                                            className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40 disabled:opacity-50 transition-colors"
                                          >
                                            {importingFileId === file.id
                                              ? "Connecting..."
                                              : "Connect"}
                                          </button>
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </>
                          )}
                      </div>

                      {/* ── Connect to shared profile ── */}
                      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                          Connect to shared profile
                        </h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                          Paste a Google Drive share link from a collaborator.
                        </p>
                        <form
                          onSubmit={handleConnectSharedProfile}
                          className="space-y-2"
                        >
                          <input
                            type="text"
                            value={shareUrl}
                            onChange={(e) => setShareUrl(e.target.value)}
                            placeholder="https://drive.google.com/file/d/..."
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-500 dark:bg-gray-700 dark:text-gray-100 text-sm"
                            required
                          />
                          <div className="flex items-center gap-3">
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
                            <button
                              type="submit"
                              disabled={isConnecting}
                              className="px-3 py-1.5 text-sm bg-teal-500 text-white rounded-md hover:bg-teal-600 transition-colors disabled:opacity-50"
                            >
                              {isConnecting ? "Connecting..." : "Connect"}
                            </button>
                          </div>
                          {connectError && (
                            <p className="text-xs text-red-600 dark:text-red-400">
                              {connectError}
                            </p>
                          )}
                        </form>
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
