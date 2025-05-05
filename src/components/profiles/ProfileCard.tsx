"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useProfileEdit } from "@/hooks/useProfileEdit";
import { format, formatDistanceToNow } from "date-fns";
import { useProfileStore } from "@/store/profileStore";
import { Profile, DEFAULT_BACKUP_REMINDER_PERIOD_MS } from "@/lib/db";
import {
  useGoogleDriveSync,
  getLocalProfileSyncData,
  getProfileSyncFilename,
} from "@/hooks/useGoogleDriveSync"; // Import sync hook and helpers

const MS_IN_DAY = 1000 * 60 * 60 * 24;

// Helper to convert period (ms) to days string, handling 'Never' (-1)
function formatReminderPeriod(periodMs: number | undefined): string {
  if (periodMs === -1) {
    return "Disabled";
  }
  if (periodMs === undefined || periodMs <= 0) {
    // Handle undefined or invalid positive values by showing default
    const defaultDays = Math.round(
      DEFAULT_BACKUP_REMINDER_PERIOD_MS / MS_IN_DAY,
    );
    return `${defaultDays} days (Default)`;
  }
  const days = Math.round(periodMs / MS_IN_DAY);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

interface ProfileCardProps {
  profile: Profile;
  isActive: boolean;
}

export default function ProfileCard({ profile, isActive }: ProfileCardProps) {
  const {
    setActiveProfileId,
    updateProfile,
    deleteProfile,
    isGoogleSignedIn,
    googleAccessToken,
    needsReauth,
    openProfileManager,
  } = useProfileStore();

  // Get profile edit functionality
  const { openProfileEditor } = useProfileEdit();

  // Sync Hook (needed for actions and status)
  const {
    syncProfile,
    uploadDriveFile,
    syncStatus: driveHookStatus,
    error: driveHookError,
  } = useGoogleDriveSync();

  const { pauseSync, resumeSync, isSyncPaused, getSyncResumeTime } =
    useProfileStore();

  // Component State
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLinking, setIsLinking] = useState(false);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null); // Local error state for card actions
  const [isPickerLoading, setIsPickerLoading] = useState(false); // State for picker loading
  const [lastSyncInitiatedByThisCard, setLastSyncInitiatedByThisCard] =
    useState(false); // Track if this card triggered the last sync

  // Sync pause states
  const [isPausing, setIsPausing] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [selectedPauseDuration, setSelectedPauseDuration] =
    useState<string>("1h");
  const [showPauseOptions, setShowPauseOptions] = useState(false);

  // Dynamically import the Google Drive Picker component on the client side only
  useEffect(() => {
    // Only import the component in the browser
    if (typeof window !== "undefined") {
      import("@googleworkspace/drive-picker-element").catch((err) => {
        console.error("Error importing Google Drive Picker component:", err);
      });
    }
  }, []);

  const handleDelete = async () => {
    if (isActive) {
      alert(
        "Cannot delete the active profile. Please switch to another profile first.",
      );
      return;
    }

    try {
      setIsDeleting(true);
      await deleteProfile(profile.id!);
      setIsDeleting(false);
    } catch (error) {
      console.error("Failed to delete profile:", error);
      alert("Failed to delete profile. Please try again.");
      setIsDeleting(false);
    }
  };

  const handleActivate = () => {
    if (!isActive) {
      setActiveProfileId(profile.id!);
    }
  };

  // --- Drive Action Handlers for this specific card ---

  const handleCreateAndLinkDriveFile = useCallback(async () => {
    if (!profile.id) return;
    setIsLinking(true);
    setCardError(null);
    try {
      const syncData = await getLocalProfileSyncData(profile.id);
      if (!syncData) throw new Error("Could not load profile data.");

      const fileName = getProfileSyncFilename(profile.name);
      const uploadedFile = await uploadDriveFile(
        fileName,
        syncData,
        null,
        profile.id,
      );

      // Update local profile with the new file ID
      await updateProfile(profile.id, { googleDriveFileId: uploadedFile.id });
      console.log(
        `Profile ${profile.id} linked to Drive file ${uploadedFile.id}`,
      );
      // Optionally trigger an immediate sync?
      // await syncProfile(profile.id);
    } catch (error) {
      console.error("Failed to create and link Drive file:", error);
      setCardError(
        error instanceof Error
          ? error.message
          : "Failed to link profile to Google Drive.",
      );
    } finally {
      setIsLinking(false);
    }
  }, [profile.id, profile.name, uploadDriveFile, updateProfile]);

  const handleManualSync = useCallback(async () => {
    if (!profile.id) return;
    setIsSyncingNow(true);
    setCardError(null);
    setLastSyncInitiatedByThisCard(true); // Mark that this card initiated the sync
    try {
      // The syncProfile function handles status updates via the hook's state
      const result = await syncProfile(profile.id);
      if (result.status === "error") {
        throw new Error(result.error || "Sync failed.");
      }
      if (result.status === "conflict") {
        // Conflict modal will be shown by ProfileManager based on hook state
        console.log(
          `Sync conflict detected for profile ${profile.id}. Modal should appear.`,
        );
      }
    } catch (error) {
      console.error("Failed to manually sync profile:", error);
      setCardError(
        error instanceof Error ? error.message : "Failed to sync profile.",
      );
    } finally {
      setIsSyncingNow(false);
      // Don't reset lastSyncInitiatedByThisCard here, wait for status change effect
    }
  }, [profile.id, syncProfile]);

  const handleUnlinkDriveFile = useCallback(async () => {
    if (!profile.id) return;
    if (
      !window.confirm(
        `Are you sure you want to unlink profile "${profile.name}" from Google Drive? The file in Drive will not be deleted, but the link will be removed.`,
      )
    ) {
      return;
    }
    setIsUnlinking(true);
    setCardError(null);
    try {
      await updateProfile(profile.id, { googleDriveFileId: null });
      console.log(`Profile ${profile.id} unlinked from Drive.`);
    } catch (error) {
      console.error("Failed to unlink profile:", error);
      setCardError(
        error instanceof Error ? error.message : "Failed to unlink profile.",
      );
    } finally {
      setIsUnlinking(false);
    }
  }, [profile.id, profile.name, updateProfile]);

  // Create ref for the drive-picker component
  const pickerRef = useRef<HTMLElement | null>(null);

  // Handler for linking to an existing file using the new Drive Picker Web Component
  const handleLinkToExisting = useCallback(async () => {
    if (!profile.id || !googleAccessToken) {
      setCardError("Cannot open picker: Missing profile ID or not signed in.");
      return;
    }

    setIsPickerLoading(true);
    setCardError(null);

    try {
      // Ensure the Google Drive Picker component is loaded
      if (
        typeof window !== "undefined" &&
        !customElements.get("drive-picker")
      ) {
        await import("@googleworkspace/drive-picker-element");
      }

      // Get the client ID from environment
      const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

      if (!clientId) {
        throw new Error("Google Client ID not configured");
      }

      // Create a Google Drive Picker web component
      const pickerElement = document.createElement("drive-picker");
      pickerElement.setAttribute("client-id", clientId);
      pickerElement.setAttribute("oauth-token", googleAccessToken);
      pickerElement.setAttribute("nav-hidden", "true");

      // Add a docs view
      const docsView = document.createElement("drive-picker-docs-view");
      docsView.setAttribute("mime-types", "application/json");
      pickerElement.appendChild(docsView);

      // Add event listeners
      pickerElement.addEventListener("picker:picked", (event: Event) => {
        const customEvent = event as CustomEvent;
        const docs = customEvent.detail?.docs;

        if (Array.isArray(docs) && docs.length > 0) {
          const fileId = docs[0].id;
          if (fileId) {
            console.log(`Picker selected file ID: ${fileId}`);
            updateProfile(profile.id!, { googleDriveFileId: fileId })
              .then(() => {
                console.log(
                  `Profile ${profile.id} linked to existing Drive file ${fileId}`,
                );
              })
              .catch((error) => {
                console.error(
                  "Failed to update profile with selected file ID:",
                  error,
                );
                setCardError(
                  error instanceof Error
                    ? error.message
                    : "Failed to link profile.",
                );
              })
              .finally(() => {
                setIsPickerLoading(false);

                // Remove the picker element after use
                if (pickerElement.parentNode) {
                  pickerElement.parentNode.removeChild(pickerElement);
                }
              });
          }
        } else {
          console.warn("Picker selection did not contain any documents.");
          setCardError("No file selected or selection invalid.");
          setIsPickerLoading(false);
        }
      });

      pickerElement.addEventListener("picker:canceled", () => {
        console.log("Picker cancelled by user.");
        setIsPickerLoading(false);

        // Remove the picker element after use
        if (pickerElement.parentNode) {
          pickerElement.parentNode.removeChild(pickerElement);
        }
      });

      pickerElement.addEventListener("picker:error", (event: Event) => {
        const customEvent = event as CustomEvent;
        console.error("Picker error:", customEvent.detail);
        setCardError("Failed to select file. Please try again.");
        setIsPickerLoading(false);

        // Remove the picker element after use
        if (pickerElement.parentNode) {
          pickerElement.parentNode.removeChild(pickerElement);
        }
      });

      // Add to DOM temporarily and show the picker
      document.body.appendChild(pickerElement);
      pickerRef.current = pickerElement;

      // Make the picker visible
      // The visible property is set directly on the element
      pickerElement.setAttribute("visible", "true");
    } catch (error) {
      console.error("Error initializing Drive Picker:", error);
      setCardError(
        error instanceof Error
          ? error.message
          : "Failed to initialize file picker",
      );
      setIsPickerLoading(false);
    }
  }, [googleAccessToken, profile.id, updateProfile]);

  // Effect to clear the 'initiated by this card' flag when hook status resets
  useEffect(() => {
    if (driveHookStatus === "idle" || driveHookStatus === "success") {
      setLastSyncInitiatedByThisCard(false);
    }
    // Clear local card error if global hook error clears or status becomes idle/success
    if (
      (driveHookStatus === "idle" ||
        driveHookStatus === "success" ||
        !driveHookError) &&
      cardError
    ) {
      setCardError(null);
    }
  }, [driveHookStatus, driveHookError, cardError]);

  // Determine what status to show based on global hook status and local interaction
  const displayStatus = useMemo(() => {
    // Authentication expired - show re-auth message
    if (needsReauth) {
      return {
        text: "Authentication expired",
        color: "text-red-600 dark:text-red-400",
        needsAuth: true,
      };
    }

    if (driveHookStatus === "syncing" && isSyncingNow)
      return { text: "Syncing...", color: "text-blue-600 dark:text-blue-400" };
    if (driveHookStatus === "conflict" && lastSyncInitiatedByThisCard)
      return {
        text: "Conflict",
        color: "text-yellow-600 dark:text-yellow-400",
      };
    // Show global error if it exists, otherwise show local card error
    const errorToShow = driveHookError || cardError;
    if (
      errorToShow &&
      (lastSyncInitiatedByThisCard || driveHookStatus === "error")
    )
      return {
        text: `Error: ${errorToShow.substring(0, 50)}${errorToShow.length > 50 ? "..." : ""}`,
        color: "text-red-600 dark:text-red-400",
      };
    // Show success briefly if this card initiated it
    if (driveHookStatus === "success" && lastSyncInitiatedByThisCard)
      return { text: "Synced", color: "text-green-600 dark:text-green-400" };
    // TODO: Add 'Synced [timestamp]' later if needed
    return null; // Default: show nothing or 'Idle'
  }, [
    driveHookStatus,
    driveHookError,
    cardError,
    isSyncingNow,
    lastSyncInitiatedByThisCard,
    needsReauth,
  ]);

  return (
    <div
      className={`border rounded-lg p-4 ${
        isActive
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      }`}
    >
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {profile.name}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {profile.syncType === "googleDrive"
              ? "Google Drive Sync"
              : "Local Storage Only"}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Created{" "}
            {formatDistanceToNow(new Date(profile.createdAt), {
              addSuffix: true,
            })}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Backup Reminder:{" "}
            {formatReminderPeriod(profile.backupReminderPeriod)}
          </p>
          {/* Sync Status Display */}
          {profile.syncType === "googleDrive" &&
            isGoogleSignedIn &&
            displayStatus && (
              <div className="mt-1">
                <p className={`text-xs font-medium ${displayStatus.color}`}>
                  Sync Status: {displayStatus.text}
                </p>
                {/* Add sign in again button if auth is expired */}
                {displayStatus.needsAuth && (
                  <button
                    onClick={() => openProfileManager()}
                    className="mt-1 px-2 py-0.5 text-xs bg-red-100 text-red-800 rounded hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-800/40"
                  >
                    Sign in again
                  </button>
                )}
              </div>
            )}
        </div>
        <div className="flex space-x-1">
          {isActive ? (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              Active
            </span>
          ) : (
            <button
              onClick={handleActivate}
              className="px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
            >
              Activate
            </button>
          )}
        </div>
      </div>

      <div className="flex mt-4 space-x-2">
        {/* Standard Edit/Delete Buttons */}
        <button
          onClick={() => openProfileEditor(profile)}
          className="px-3 py-1 bg-gray-100 text-gray-800 rounded-md text-sm hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          Edit Profile
        </button>
        {!isActive &&
          (isDeleting ? (
            <button
              disabled
              className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm opacity-50 dark:bg-red-900/30 dark:text-red-300"
            >
              Deleting...
            </button>
          ) : (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Are you sure you want to delete the profile "${profile.name}"? This cannot be undone.`,
                  )
                ) {
                  handleDelete();
                }
              }}
              className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm hover:bg-red-200 transition-colors dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-800/40"
            >
              Delete
            </button>
          ))}
      </div>

      {/* Google Drive Sync Actions (View Mode) */}
      {profile.syncType === "googleDrive" && isGoogleSignedIn && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2">
          <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">
            Google Drive Sync
          </h4>
          {cardError && (
            <p className="text-xs text-red-600 dark:text-red-400">
              Error: {cardError}
            </p>
          )}

          {/* Pause Sync Status */}
          {profile.googleDriveFileId && isSyncPaused(profile.id!) && (
            <div className="px-3 py-2 bg-purple-50 dark:bg-purple-900/20 rounded-md">
              <p className="text-xs text-purple-700 dark:text-purple-300 font-medium">
                Sync Paused until{" "}
                {format(
                  new Date(getSyncResumeTime(profile.id!) || Date.now()),
                  "h:mm a, MMM d",
                )}
              </p>
              <button
                onClick={async () => {
                  setIsResuming(true);
                  try {
                    await resumeSync(profile.id!);
                  } catch (error) {
                    console.error("Error resuming sync:", error);
                    setCardError("Failed to resume sync");
                  } finally {
                    setIsResuming(false);
                  }
                }}
                disabled={isResuming}
                className="mt-1 px-2 py-0.5 text-xs bg-purple-100 text-purple-800 rounded hover:bg-purple-200 transition-colors dark:bg-purple-800/30 dark:text-purple-300 dark:hover:bg-purple-700/40 disabled:opacity-50"
              >
                {isResuming ? "Resuming..." : "Resume Now"}
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!profile.googleDriveFileId ? (
              // Not Linked - Show two buttons side by side
              <>
                <button
                  onClick={handleCreateAndLinkDriveFile}
                  disabled={isLinking}
                  className="px-3 py-1 text-xs bg-green-100 text-green-800 rounded-md hover:bg-green-200 transition-colors dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-800/40 disabled:opacity-50"
                >
                  {isLinking ? "Linking..." : "Link to Drive"}
                </button>
                <button
                  onClick={() => handleLinkToExisting()}
                  disabled={isLinking || isPickerLoading}
                  className="px-3 py-1 text-xs bg-cyan-100 text-cyan-800 rounded-md hover:bg-cyan-200 transition-colors dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-800/40 disabled:opacity-50"
                >
                  {isPickerLoading ? "Loading..." : "Link to Existing..."}
                </button>
              </>
            ) : (
              // Linked - Show sync controls
              <>
                <button
                  onClick={handleManualSync}
                  disabled={isSyncingNow || isSyncPaused(profile.id!)}
                  className="px-3 py-1 text-xs bg-blue-100 text-blue-800 rounded-md hover:bg-blue-200 transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40 disabled:opacity-50"
                >
                  {isSyncingNow ? "Syncing..." : "Sync Now"}
                </button>

                {/* Pause Sync Button and Dropdown */}
                {!isSyncPaused(profile.id!) ? (
                  <div className="relative">
                    <button
                      onClick={() => setShowPauseOptions(!showPauseOptions)}
                      className="px-3 py-1 text-xs bg-purple-100 text-purple-800 rounded-md hover:bg-purple-200 transition-colors dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-800/40"
                    >
                      Pause Sync
                    </button>

                    {showPauseOptions && (
                      <div className="absolute z-10 mt-1 bg-white dark:bg-gray-800 shadow-lg rounded-md border border-gray-200 dark:border-gray-700 w-48 py-1">
                        <div className="px-3 py-2">
                          <select
                            value={selectedPauseDuration}
                            onChange={(e) =>
                              setSelectedPauseDuration(e.target.value)
                            }
                            className="w-full text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-gray-300"
                          >
                            <option value="1h">1 hour</option>
                            <option value="4h">4 hours</option>
                            <option value="8h">8 hours</option>
                            <option value="1d">Until tomorrow</option>
                            <option value="custom">Custom...</option>
                          </select>

                          <div className="flex space-x-1 mt-2">
                            <button
                              onClick={async () => {
                                setShowPauseOptions(false);
                                setIsPausing(true);

                                try {
                                  // Calculate duration in milliseconds
                                  let durationMs = 0;
                                  switch (selectedPauseDuration) {
                                    case "1h":
                                      durationMs = 60 * 60 * 1000; // 1 hour
                                      break;
                                    case "4h":
                                      durationMs = 4 * 60 * 60 * 1000; // 4 hours
                                      break;
                                    case "8h":
                                      durationMs = 8 * 60 * 60 * 1000; // 8 hours
                                      break;
                                    case "1d":
                                      // Until tomorrow (8am)
                                      const tomorrow = new Date();
                                      tomorrow.setDate(tomorrow.getDate() + 1);
                                      tomorrow.setHours(8, 0, 0, 0);
                                      durationMs =
                                        tomorrow.getTime() - Date.now();
                                      break;
                                    case "custom":
                                      // Could open a modal or prompt here
                                      durationMs = 4 * 60 * 60 * 1000; // Default to 4 hours if not specified
                                      break;
                                  }

                                  await pauseSync(profile.id!, durationMs);
                                } catch (error) {
                                  console.error("Error pausing sync:", error);
                                  setCardError("Failed to pause sync");
                                } finally {
                                  setIsPausing(false);
                                }
                              }}
                              disabled={isPausing}
                              className="px-2 py-1 text-xs bg-purple-500 text-white rounded hover:bg-purple-600 transition-colors flex-1"
                            >
                              {isPausing ? "Pausing..." : "Pause"}
                            </button>
                            <button
                              onClick={() => setShowPauseOptions(false)}
                              className="px-2 py-1 text-xs bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                <button
                  onClick={handleUnlinkDriveFile}
                  disabled={isUnlinking}
                  className="px-3 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-md hover:bg-yellow-200 transition-colors dark:bg-yellow-900/30 dark:text-yellow-300 dark:hover:bg-yellow-800/40 disabled:opacity-50"
                >
                  {isUnlinking ? "Unlinking..." : "Unlink"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
