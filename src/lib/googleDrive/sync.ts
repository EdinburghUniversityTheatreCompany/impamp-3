/**
 * Synchronization logic for Google Drive integration
 * Handles profile syncing, conflict resolution, and error handling
 */

import { updateProfile, getProfile } from "@/lib/db";
import { detectProfileConflicts } from "@/lib/syncUtils";
import { getProfileSyncFilename, updateSyncTimestamp } from "./utils";
import { getLocalProfileSyncData, updateLocalData } from "./dataAccess";
import {
  downloadDriveFile,
  findDriveFileById,
  findDriveFileByName,
  uploadDriveFile,
} from "./api";
import {
  ProfileSyncData,
  SyncStatus,
  SyncResult,
  SyncResultSuccess,
  SyncResultError,
  SyncResultPaused,
  SyncResultSkipped,
  SyncResultConflict,
  TokenInfo,
  ItemConflict,
} from "./types";

/**
 * Interface for sync status callbacks
 */
interface SyncStatusCallbacks {
  onStatusChange: (status: SyncStatus) => void;
  onError: (error: string | null) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
  onConflictDataAvailable: (
    data: {
      local: ProfileSyncData;
      remote: ProfileSyncData;
      fileId: string;
    } | null,
  ) => void;
}

/**
 * Synchronize a profile with Google Drive
 * @param profileId The profile ID to sync
 * @param tokenInfo Current token information
 * @param callbacks Status update callbacks
 * @param refreshCallback Callback to update token if refreshed
 * @returns The sync result
 */
export const syncProfile = async (
  profileId: number,
  tokenInfo: TokenInfo | null,
  callbacks: SyncStatusCallbacks,
  refreshCallback: (token: TokenInfo) => void,
): Promise<SyncResult> => {
  const {
    onStatusChange,
    onError,
    onConflictsDetected,
    onConflictDataAvailable,
  } = callbacks;

  onStatusChange("syncing");
  onError(null);
  onConflictsDetected([]);
  onConflictDataAvailable(null);

  console.log(`Starting sync for profile ID: ${profileId}`);

  try {
    // Get the profile from IndexedDB
    const localProfile = await getProfile(profileId);
    if (!localProfile) {
      throw new Error(`Profile ${profileId} not found locally.`);
    }

    // Check if sync is paused for this profile
    if (
      localProfile.syncPausedUntil &&
      Date.now() < localProfile.syncPausedUntil
    ) {
      const resumeTime = new Date(
        localProfile.syncPausedUntil,
      ).toLocaleString();
      console.log(`Sync paused for profile ${profileId} until ${resumeTime}`);
      onStatusChange("idle");
      onError(`Sync paused until ${resumeTime}`);
      return {
        status: "paused",
        resumeTime: localProfile.syncPausedUntil,
      };
    }

    // Check if profile is set to Google Drive sync
    if (localProfile.syncType !== "googleDrive") {
      console.log(`Profile ${profileId} is not set to Google Drive sync type.`);
      onStatusChange("idle");
      return {
        status: "skipped",
        reason: "Not a Google Drive profile",
      };
    }

    // Check authentication
    if (!tokenInfo?.accessToken) {
      onStatusChange("error");
      onError("Not authenticated with Google Drive");
      return {
        status: "error",
        error: "Not authenticated with Google Drive",
      };
    }

    let fileId = localProfile.googleDriveFileId;
    let driveFile = null;

    // If the profile is already linked to a Drive file, check if it still exists
    if (fileId) {
      driveFile = await findDriveFileById(fileId, tokenInfo, refreshCallback);
      if (!driveFile) {
        console.warn(
          `Linked Drive file ${fileId} not found for profile ${profileId}. Trying to find by name...`,
        );
        fileId = null; // Reset fileId as the link is broken
      }
    }

    // If not linked or link is broken, try to find by name
    if (!fileId) {
      const fileName = getProfileSyncFilename(localProfile.name);
      driveFile = await findDriveFileByName(
        fileName,
        tokenInfo,
        refreshCallback,
      );

      if (driveFile) {
        console.log(
          `Found existing Drive file by name: ${fileName} (ID: ${driveFile.id}). Relinking profile.`,
        );
        fileId = driveFile.id;
        // Update local profile with the found file ID
        await updateProfile(profileId, { googleDriveFileId: fileId });
      } else {
        console.log(
          `No existing Drive file found for profile ${profileId} by name or ID.`,
        );
        // Continue with initial upload scenario
      }
    }

    // 1. Get Local Data
    const localData = await getLocalProfileSyncData(profileId);
    if (!localData) {
      throw new Error("Could not load local profile data.");
    }

    // 2. Get Remote Data (if file exists)
    const remoteData = fileId
      ? await downloadDriveFile(fileId, tokenInfo, refreshCallback)
      : null;

    // 3. Detect Conflicts & Merge
    const {
      conflicts: detectedConflicts,
      requiresManualResolution,
      mergedData,
    } = detectProfileConflicts(localData, remoteData);

    if (requiresManualResolution) {
      console.log(`Sync conflict detected for profile ${profileId}`);
      onConflictsDetected(detectedConflicts);

      // Ensure remoteData is not null when setting conflictData
      if (remoteData && fileId) {
        const conflictData = {
          local: localData,
          remote: remoteData,
          fileId: fileId,
        };

        onConflictDataAvailable(conflictData);
        onStatusChange("conflict");
        onError("Sync conflicts detected. Manual resolution required.");

        return {
          status: "conflict",
          conflicts: detectedConflicts,
        };
      } else {
        // Should not happen if requiresManualResolution is true
        throw new Error("Conflict detected but remote data is missing.");
      }
    } else {
      // No conflicts, or automatically merged
      console.log(`Auto-merging/updating profile ${profileId}`);
      const driveFileName = getProfileSyncFilename(mergedData.profile.name);

      // Set the timestamp *before* uploading
      mergedData._lastSyncTimestamp = Date.now();

      // 4. Upload Merged Data to Drive (Create or Update)
      const uploadedFile = await uploadDriveFile(
        driveFileName,
        mergedData,
        fileId,
        profileId,
        tokenInfo,
        refreshCallback,
      );

      // 5. Update Local Data with Merged Data
      await updateLocalData(profileId, mergedData);

      // 6. Ensure local profile has the correct file ID
      if (uploadedFile.id !== fileId) {
        await updateProfile(profileId, {
          googleDriveFileId: uploadedFile.id,
        });
      }

      onStatusChange("success");
      console.log(`Profile ${profileId} synced successfully.`);
      return {
        status: "success",
        data: mergedData,
      };
    }
  } catch (err) {
    console.error(`Sync failed for profile ${profileId}:`, err);
    const message =
      err instanceof Error ? err.message : "An unknown sync error occurred.";
    onError(message);
    onStatusChange("error");
    return {
      status: "error",
      error: message,
    };
  }
};

/**
 * Apply conflict resolution data
 * @param resolvedData The resolved sync data
 * @param fileId The Drive file ID
 * @param profileId The profile ID
 * @param tokenInfo Current token information
 * @param callbacks Status update callbacks
 * @param refreshCallback Callback to update token if refreshed
 * @returns The sync result
 */
export const applyConflictResolution = async (
  resolvedData: ProfileSyncData,
  fileId: string,
  profileId: number,
  tokenInfo: TokenInfo | null,
  callbacks: SyncStatusCallbacks,
  refreshCallback: (token: TokenInfo) => void,
): Promise<SyncResult> => {
  const {
    onStatusChange,
    onError,
    onConflictsDetected,
    onConflictDataAvailable,
  } = callbacks;

  onStatusChange("syncing");
  onError(null);
  onConflictsDetected([]);
  onConflictDataAvailable(null);

  try {
    // Check authentication
    if (!tokenInfo?.accessToken) {
      onStatusChange("error");
      onError("Not authenticated with Google Drive");
      return {
        status: "error",
        error: "Not authenticated with Google Drive",
      };
    }

    // Set a fresh timestamp for the resolution
    resolvedData._lastSyncTimestamp = Date.now();

    // Generate the filename based on profile name
    const driveFileName = getProfileSyncFilename(resolvedData.profile.name);

    // Upload the resolved data to Drive
    const uploadedFile = await uploadDriveFile(
      driveFileName,
      resolvedData,
      fileId,
      profileId,
      tokenInfo,
      refreshCallback,
    );

    // Update local data with the resolved data
    await updateLocalData(profileId, resolvedData);

    // Ensure the profile has the correct file ID
    if (uploadedFile.id !== fileId) {
      await updateProfile(profileId, {
        googleDriveFileId: uploadedFile.id,
      });
    }

    // Update the sync timestamp
    updateSyncTimestamp(profileId, resolvedData._lastSyncTimestamp);

    onStatusChange("success");
    console.log(
      `Conflict resolution applied successfully for profile ${profileId}`,
    );

    return {
      status: "success",
      data: resolvedData,
    };
  } catch (err) {
    console.error(
      `Failed to apply conflict resolution for profile ${profileId}:`,
      err,
    );
    const message =
      err instanceof Error ? err.message : "Failed to apply resolved data.";
    onError(message);
    onStatusChange("error");

    return {
      status: "error",
      error: message,
    };
  }
};
