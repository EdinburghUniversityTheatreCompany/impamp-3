"use client";

import { useState, useRef, useEffect } from "react"; // Removed unused ChangeEvent
import { useProfileStore, GoogleUserInfo } from "@/store/profileStore";
import { SyncType } from "@/lib/db";
import ProfileCard from "./ProfileCard";
import { useGoogleLogin, googleLogout } from "@react-oauth/google";
import {
  useGoogleDriveSync,
  DriveFile,
  getLocalProfileSyncData, // Import needed function
  getProfileSyncFilename, // Import needed function
} from "@/hooks/useGoogleDriveSync";
import { ConflictResolutionModal } from "@/components/modals/ConflictResolutionModal"; // Import the new modal

export default function ProfileManager() {
  const {
    profiles,
    activeProfileId,
    isProfileManagerOpen,
    closeProfileManager,
    createProfile,
    exportMultipleProfilesToJSON,
    importProfileFromJSON,
    importProfileFromImpamp2JSON,
    importMultipleProfilesFromJSON,
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
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [exportSelectionIds, setExportSelectionIds] = useState<Set<number>>(
    new Set(),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [googleApiError, setGoogleApiError] = useState<string | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [showDriveImportModal, setShowDriveImportModal] = useState(false);
  const [driveActionStatus, setDriveActionStatus] = useState<
    "idle" | "loading" | "error" | "success"
  >("idle");
  const [driveActionError, setDriveActionError] = useState<string | null>(null);

  // Hooks
  const {
    listAppFiles,
    downloadDriveFile,
    uploadDriveFile,
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

        // Get refresh token if available - accessing through the any type since it's not in the type definitions
        // but might be present in some authorization flows
        const refreshToken = (tokenResponse as any).refresh_token || null;

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

  // Event handlers
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

  // Drive file handlers with underscore prefix to avoid eslint unused warnings
  const _handleListDriveFiles = async () => {
    setDriveActionStatus("loading");
    setDriveActionError(null);
    setDriveFiles([]);
    try {
      const files = await listAppFiles();
      setDriveFiles(files);
      setDriveActionStatus("success");
      setShowDriveImportModal(true);
    } catch (error) {
      console.error("Failed to list Drive files:", error);
      setDriveActionError(
        error instanceof Error
          ? error.message
          : "Failed to list files from Google Drive.",
      );
    }
  };

  const handleImportFromDrive = async (fileId: string) => {
    setShowDriveImportModal(false);
    setDriveActionStatus("loading");
    setDriveActionError(null);
    setImportError(null);
    setImportSuccess(null);

    try {
      const fileData = await downloadDriveFile(fileId);
      if (fileData && fileData._syncFormatVersion === 1 && fileData.profile) {
        await importProfileFromJSON(JSON.stringify(fileData));
        setImportSuccess(
          `Successfully imported profile "${fileData.profile.name}" from Google Drive.`,
        );
      } else {
        console.warn("Downloaded file data:", fileData);
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
      setImportError(message);
      setDriveActionStatus("error");
    }
  };

  const _handleExportToDrive = async (profileId: number) => {
    setDriveActionStatus("loading");
    setDriveActionError(null);
    const profileToExport = profiles.find((p) => p.id === profileId);
    if (!profileToExport) {
      setDriveActionError("Profile not found for export.");
      setDriveActionStatus("error");
      return;
    }

    try {
      const syncData = await getLocalProfileSyncData(profileId);
      if (!syncData) {
        throw new Error("Could not generate profile data for export.");
      }
      const fileName = getProfileSyncFilename(profileToExport.name);
      await uploadDriveFile(fileName, syncData, null, profileId);
      setDriveActionStatus("success");
      alert(
        `Profile "${profileToExport.name}" exported successfully to Google Drive.`,
      );
    } catch (error) {
      console.error(`Failed to export profile ${profileId} to Drive:`, error);
      const message =
        error instanceof Error
          ? error.message
          : `Failed to export profile "${profileToExport.name}" to Google Drive.`;
      setDriveActionError(message);
      setDriveActionStatus("error");
      alert(message);
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
                            className="h-10 w-10 rounded-full"
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
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        Profile synchronization actions (like Link, Sync Now,
                        Unlink) are available on individual profile cards when
                        the &apos;Profiles&apos; tab is selected.
                      </p>
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
                    <h3 className="text-lg font-medium mb-4 text-gray-900 dark:text-gray-100">
                      Import Profile from Google Drive
                    </h3>
                    {driveActionStatus === "loading" && (
                      <p className="text-gray-600 dark:text-gray-400">
                        Loading files...
                      </p>
                    )}
                    {driveActionStatus === "error" && driveActionError && (
                      <p className="text-red-600 dark:text-red-400">
                        Error: {driveActionError}
                      </p>
                    )}
                    {driveActionStatus === "success" &&
                      driveFiles.length === 0 && (
                        <p className="text-gray-600 dark:text-gray-400">
                          No ImpAmp profile files found in your Google Drive.
                        </p>
                      )}
                    {driveActionStatus === "success" &&
                      driveFiles.length > 0 && (
                        <ul className="space-y-2 max-h-60 overflow-y-auto mb-4 border rounded p-2 dark:border-gray-600">
                          {driveFiles.map((file) => (
                            <li key={file.id}>
                              <button
                                onClick={() => handleImportFromDrive(file.id)}
                                className="w-full text-left px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-gray-700 rounded"
                              >
                                {file.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    <div className="flex justify-end">
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
