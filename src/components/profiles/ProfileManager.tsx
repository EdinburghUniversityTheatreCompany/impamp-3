"use client";

import { useState, useEffect } from "react";
import { useProfileStore, GoogleUserInfo } from "@/store/profileStore";
import { SyncType, Profile, PadConfiguration, PageMetadata } from "@/lib/db";
import ProfileCard from "./ProfileCard";
import { useGoogleLogin, googleLogout } from "@react-oauth/google";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { ConflictResolutionModal } from "@/components/modals/ConflictResolutionModal";
import { ProfileSyncData } from "@/lib/syncUtils";

export default function ProfileManager() {
  const {
    profiles,
    activeProfileId,
    isProfileManagerOpen,
    closeProfileManager,
    createProfile,
    importProfileFromJSON,
    isGoogleSignedIn,
    googleUser,
    setGoogleAuthDetails,
    clearGoogleAuthDetails,
  } = useProfileStore();

  // State management
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileSyncType, setNewProfileSyncType] =
    useState<SyncType>("local");
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<"profiles" | "import-export">(
    "profiles",
  );

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
  const [showDriveImportModal, setShowDriveImportModal] = useState(false);
  const [driveActionStatus, setDriveActionStatus] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle");
  const [driveActionError, setDriveActionError] = useState<string | null>(null);
  const [importingFileId, setImportingFileId] = useState<string | null>(null);

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

  // Handle showing the Drive import modal and loading files
  const handleShowDriveImportModal = async () => {
    setShowDriveImportModal(true);
    setDriveActionStatus("loading");
    setDriveActionError(null);

    try {
      // Use the hook's listAppFiles function to fetch ImpAmp profile files
      const files = await listAppFiles();
      setDriveFiles(files);
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

  const handleImportFromDrive = async (fileId: string) => {
    setImportingFileId(fileId); // Track which file is being imported
    setDriveActionStatus("loading");
    setDriveActionError(null);

    try {
      const syncData = await downloadDriveFile(fileId);

      if (syncData && syncData._syncFormatVersion === 1 && syncData.profile) {
        // Convert the sync format to export format before importing
        const exportData = convertSyncToExportFormat(syncData);

        // Log the converted data for debugging
        console.log("Converting sync data to export format:", {
          syncVersion: syncData._syncFormatVersion,
          exportVersion: exportData.exportVersion,
        });

        // Import using the converted format
        await importProfileFromJSON(JSON.stringify(exportData));

        console.log(
          `Successfully imported profile "${syncData.profile.name}" from Google Drive.`,
        );
        // Close modal on success
        setShowDriveImportModal(false);
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

  if (!isProfileManagerOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black bg-opacity-50">
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
              {/* Simplified Google Drive Integration section */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Google Drive Integration
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Connect your Google account to enable profile synchronization
                  via Google Drive&apos;s AppData folder (hidden from user).
                </p>

                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <div className="flex items-center space-x-4 mb-4 pb-4 border-b border-gray-200 dark:border-gray-700">
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
                          <img
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

                  {isGoogleSignedIn && (
                    <div className="space-y-3">
                      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                        Profile synchronization actions (like Link, Sync Now,
                        Unlink) are available on individual profile cards when
                        the &apos;Profiles&apos; tab is selected.
                      </p>

                      {/* Google Drive Import Button */}
                      <div className="mt-4">
                        <button
                          onClick={handleShowDriveImportModal}
                          className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors w-full sm:w-auto"
                        >
                          <div className="flex items-center justify-center">
                            <svg
                              className="h-5 w-5 mr-2"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path
                                fillRule="evenodd"
                                d="M2 9.5A3.5 3.5 0 005.5 13H9v2.586l-1.293-1.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 15.586V13h2.5a4.5 4.5 0 10-.616-8.958 4.002 4.002 0 10-7.753 1.977A3.5 3.5 0 002 9.5zm9 3.5H9V8a1 1 0 012 0v5z"
                                clipRule="evenodd"
                              />
                            </svg>
                            Import Profiles from Google Drive
                          </div>
                        </button>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                          Choose from previously exported profiles stored in
                          your Google Drive.
                        </p>
                      </div>

                      {driveActionStatus === "error" && driveActionError && (
                        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                          Drive Action Error: {driveActionError}
                        </p>
                      )}
                      {driveHookStatus === "error" &&
                        driveHookError &&
                        !driveActionError && (
                          <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                            Sync Error: {driveHookError}
                          </p>
                        )}
                      {driveHookStatus === "conflict" && driveHookError && (
                        <p className="mt-2 text-xs text-yellow-600 dark:text-yellow-400">
                          Sync Conflict: {driveHookError}
                        </p>
                      )}
                    </div>
                  )}

                  {googleApiError && !isGoogleSignedIn && (
                    <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                      Auth Error: {googleApiError}
                    </p>
                  )}
                </div>
              </section>

              {/* Drive Import Modal */}
              {showDriveImportModal && (
                <div className="fixed inset-0 z-60 bg-black bg-opacity-60 flex items-center justify-center p-4">
                  <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-lg w-full">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                        Import Profile from Google Drive
                      </h3>
                      <button
                        onClick={() => setShowDriveImportModal(false)}
                        className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                        aria-label="Close"
                      >
                        <svg
                          className="h-5 w-5"
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

                    {/* Loading State */}
                    {driveActionStatus === "loading" && (
                      <div className="flex flex-col items-center justify-center py-8">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                        <p className="mt-4 text-gray-600 dark:text-gray-400">
                          Loading files from Google Drive...
                        </p>
                      </div>
                    )}

                    {/* Error State */}
                    {driveActionStatus === "error" && driveActionError && (
                      <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-md mb-4">
                        <p className="text-red-600 dark:text-red-400">
                          <span className="font-medium">Error:</span>{" "}
                          {driveActionError}
                        </p>
                        <button
                          onClick={handleShowDriveImportModal}
                          className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Try Again
                        </button>
                      </div>
                    )}

                    {/* Success State with No Files */}
                    {driveActionStatus === "success" &&
                      driveFiles.length === 0 && (
                        <div className="text-center py-8">
                          <svg
                            className="mx-auto h-12 w-12 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
                            />
                          </svg>
                          <p className="mt-2 text-gray-600 dark:text-gray-400">
                            No ImpAmp profile files found in your Google Drive.
                          </p>
                          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                            Export a profile first to create files in your
                            Google Drive.
                          </p>
                        </div>
                      )}

                    {/* File List */}
                    {driveActionStatus === "success" &&
                      driveFiles.length > 0 && (
                        <div className="mb-4">
                          <div className="max-h-60 overflow-y-auto border rounded dark:border-gray-600">
                            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                              {driveFiles.map((file) => (
                                <li
                                  key={file.id}
                                  className="hover:bg-gray-50 dark:hover:bg-gray-700"
                                >
                                  <button
                                    onClick={() =>
                                      handleImportFromDrive(file.id)
                                    }
                                    disabled={importingFileId === file.id}
                                    className="w-full text-left p-3 flex items-center space-x-3"
                                  >
                                    <div className="flex-shrink-0">
                                      {importingFileId === file.id ? (
                                        <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                                      ) : (
                                        <svg
                                          className="h-6 w-6 text-blue-500"
                                          fill="none"
                                          viewBox="0 0 24 24"
                                          stroke="currentColor"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                          />
                                        </svg>
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                                        {file.name}
                                      </p>
                                      {file.modifiedTime && (
                                        <p className="text-xs text-gray-500 dark:text-gray-400">
                                          Modified:{" "}
                                          {new Date(
                                            file.modifiedTime,
                                          ).toLocaleString()}
                                        </p>
                                      )}
                                    </div>
                                    {!importingFileId && (
                                      <div className="flex-shrink-0">
                                        <svg
                                          className="h-5 w-5 text-gray-400"
                                          fill="none"
                                          viewBox="0 0 24 24"
                                          stroke="currentColor"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M9 5l7 7-7 7"
                                          />
                                        </svg>
                                      </div>
                                    )}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      )}

                    {/* Action Buttons */}
                    <div className="flex justify-end space-x-3">
                      {driveActionStatus === "success" && (
                        <button
                          onClick={handleShowDriveImportModal}
                          className="px-4 py-2 text-sm bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
                        >
                          Refresh Files
                        </button>
                      )}
                      <button
                        onClick={() => setShowDriveImportModal(false)}
                        className="px-4 py-2 text-sm bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300 dark:bg-gray-600 dark:text-gray-200 dark:hover:bg-gray-500"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Conflict Resolution Modal */}
              {driveHookStatus === "conflict" &&
                driveHookConflictData &&
                driveHookConflicts.length > 0 && (
                  <ConflictResolutionModal
                    conflicts={driveHookConflicts}
                    conflictData={driveHookConflictData}
                    onResolve={(resolvedData) => {
                      applyConflictResolution(
                        resolvedData,
                        driveHookConflictData.fileId,
                        driveHookConflictData.local.profile.id!,
                      );
                    }}
                    onCancel={() => {
                      console.log("Conflict resolution cancelled by user.");
                      setDriveActionStatus("idle");
                      setDriveActionError(null);
                    }}
                  />
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
