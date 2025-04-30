import { useState, useCallback, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  // Profile, // Unused
  PadConfiguration,
  PageMetadata,
  getProfile, // Keep specific types
  updateProfile, // Need updateProfile for linking file ID
  getDb, // Need getDb for updateLocalData
  getAudioFile, // Needed for fetching audio files
} from "@/lib/db";
import {
  ProfileSyncData,
  detectProfileConflicts,
  ItemConflict, // Removed Syncable (not directly used here)
  // deepClone // Not used in this file
} from "@/lib/syncUtils";
import { blobToBase64, base64ToBlob } from "@/lib/importExport";

// Define types for API responses
export interface DriveFile {
  kind: string;
  id: string;
  name: string;
  mimeType: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
}

// Define interface for the list response (used in findDriveFileByName and listAppFiles)
interface DriveFileList {
  kind: string;
  incompleteSearch: boolean; // Indicates if the list is partial
  files: DriveFile[];
}

type SyncStatus = "idle" | "syncing" | "conflict" | "error" | "success";

// Function to construct the expected filename for a profile
// Exporting for use in UI components
export const getProfileSyncFilename = (profileName: string): string => {
  const sanitizedName = profileName
    .replace(/[^a-z0-9._-]/gi, "-")
    .toLowerCase(); // Allow dots, underscores, hyphens
  return `impamp-profile-${sanitizedName}.json`;
};

// Function to gather all data for a specific profile from IndexedDB
// Exporting this function so it can be potentially used elsewhere (e.g., for manual export)
export const getLocalProfileSyncData = async (
  profileId: number,
): Promise<ProfileSyncData | null> => {
  const db = await getDb(); // Get DB instance
  const profile = await getProfile(profileId);
  if (!profile) return null;

  // Use correct DB methods to get all related items
  const padConfigurations = await db.getAllFromIndex(
    "padConfigurations",
    "profileId",
    profileId,
  );
  const pageMetadata = await db.getAllFromIndex(
    "pageMetadata",
    "profileId",
    profileId,
  );

  // Get last sync timestamp from localStorage
  const lastSyncTimestamp = parseInt(
    localStorage.getItem(`lastSync_${profileId}`) || "0",
    10,
  );

  // Get all unique audio file IDs referenced by this profile's pads
  const audioFileIds = new Set<number>();
  padConfigurations.forEach((pad) => {
    if (pad.audioFileIds && pad.audioFileIds.length > 0) {
      pad.audioFileIds.forEach((id) => audioFileIds.add(id));
    }
  });

  // Convert audio blobs to base64
  const audioFiles = [];
  for (const audioFileId of audioFileIds) {
    const audioFile = await getAudioFile(audioFileId);
    if (audioFile) {
      const base64data = await blobToBase64(audioFile.blob);
      audioFiles.push({
        id: audioFileId,
        name: audioFile.name,
        type: audioFile.type,
        data: base64data,
      });
    } else {
      console.warn(
        `Audio file with ID ${audioFileId} referenced in profile but not found in DB.`,
      );
    }
  }

  return {
    _syncFormatVersion: 1,
    _lastSyncTimestamp: lastSyncTimestamp,
    profile: profile,
    padConfigurations: padConfigurations,
    pageMetadata: pageMetadata,
    audioFiles: audioFiles,
  };
};

// Function to update local DB with merged/remote data
const updateLocalData = async (
  profileId: number,
  data: ProfileSyncData,
): Promise<void> => {
  const db = await getDb();

  // First, handle audio files import
  const audioIdMap = new Map<number, number>(); // Maps original audio file IDs to new local IDs

  if (data.audioFiles && data.audioFiles.length > 0) {
    try {
      console.log(
        `Importing ${data.audioFiles.length} audio files from sync data`,
      );

      // Create a separate transaction for audio files
      const audioTx = db.transaction(["audioFiles"], "readwrite");
      const audioStore = audioTx.objectStore("audioFiles");

      for (const audioFileData of data.audioFiles) {
        // Check if audio file already exists (by name as a basic check)
        const existingAudioFiles = await audioStore
          .index("name")
          .getAll(audioFileData.name);
        let newAudioId: number;

        if (existingAudioFiles.length > 0) {
          // For simplicity, use the first matching audio file
          newAudioId = existingAudioFiles[0].id as number;
          console.log(
            `Using existing audio file "${audioFileData.name}" (ID: ${newAudioId})`,
          );
        } else {
          // Convert base64 back to blob
          const blob = await base64ToBlob(
            audioFileData.data,
            audioFileData.type,
          );

          // Add new audio file to DB
          newAudioId = await audioStore.add({
            blob,
            name: audioFileData.name,
            type: audioFileData.type,
            createdAt: new Date(),
          });
          console.log(
            `Added new audio file "${audioFileData.name}" (ID: ${newAudioId})`,
          );
        }

        // Map original ID to new local ID
        audioIdMap.set(audioFileData.id, newAudioId);
      }

      await audioTx.done;
      console.log(
        `Audio files import complete, mapped ${audioIdMap.size} files`,
      );
    } catch (error) {
      console.error(
        `Error importing audio files for profile ${profileId}:`,
        error,
      );
      // Continue with other updates even if audio import fails
    }
  }

  // Now update profiles, pads, and pages
  const tx = db.transaction(
    ["profiles", "padConfigurations", "pageMetadata"],
    "readwrite",
  );
  const profileStore = tx.objectStore("profiles");
  const padStore = tx.objectStore("padConfigurations");
  const pageStore = tx.objectStore("pageMetadata");
  const padCompoundIndex = padStore.index("profilePagePad");
  const pageCompoundIndex = pageStore.index("profilePage");

  try {
    // 1. Update Profile
    const profileWithId = { ...data.profile, id: profileId };
    await profileStore.put(profileWithId);

    // 2. Update Pad Configurations (Upsert/Delete logic)
    const existingPads = await padStore.index("profileId").getAll(profileId); // Get current pads directly from store
    const existingPadMap = new Map(
      existingPads.map((p: PadConfiguration) => [
        `${p.pageIndex}-${p.padIndex}`,
        p,
      ]),
    ); // Add type
    const syncedPadKeys = new Set<string>();

    for (const pad of data.padConfigurations) {
      const key = `${pad.pageIndex}-${pad.padIndex}`;
      syncedPadKeys.add(key);

      // Create a copy of the pad to modify
      const padWithProfileId = { ...pad, profileId: profileId };

      // Map remote audio IDs to local audio IDs if we have mappings
      if (
        audioIdMap.size > 0 &&
        padWithProfileId.audioFileIds &&
        padWithProfileId.audioFileIds.length > 0
      ) {
        padWithProfileId.audioFileIds = padWithProfileId.audioFileIds
          .map((id) => audioIdMap.get(id) || id) // Get mapped ID or keep original if no mapping
          .filter((id) => typeof id === "number"); // Filter out any undefined/null values
      }
      // Check if pad exists locally using compound key before deciding to add/update
      const existingLocalPad = (await padCompoundIndex.get([
        profileId,
        pad.pageIndex,
        pad.padIndex,
      ])) as PadConfiguration | undefined; // Cast result
      if (existingLocalPad?.id) {
        await padStore.put({ ...padWithProfileId, id: existingLocalPad.id }); // Update existing
      } else {
        // Remove potential 'id' field from synced data if it came from remote but doesn't exist locally
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _remoteId, ...padToAdd } = padWithProfileId; // Destructure id but ignore it
        await padStore.add(padToAdd); // Add new
      }
    }
    // Delete local pads that are not in the synced data
    for (const [padKey, existingPad] of existingPadMap) {
      // existingPad is PadConfiguration here
      if (!syncedPadKeys.has(padKey) && existingPad.id) {
        await padStore.delete(existingPad.id);
      }
    }

    // 3. Update Page Metadata (Upsert/Delete logic)
    const existingPages = await pageStore.index("profileId").getAll(profileId); // Get current pages directly from store
    const existingPageMap = new Map(
      existingPages.map((p: PageMetadata) => [p.pageIndex, p]),
    ); // Add type
    const syncedPageIndices = new Set<number>();

    for (const page of data.pageMetadata) {
      syncedPageIndices.add(page.pageIndex);
      const pageWithProfileId = { ...page, profileId: profileId };
      const existingLocalPage = (await pageCompoundIndex.get([
        profileId,
        page.pageIndex,
      ])) as PageMetadata | undefined; // Cast result
      if (existingLocalPage?.id) {
        await pageStore.put({ ...pageWithProfileId, id: existingLocalPage.id }); // Update existing
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _remoteId, ...pageToAdd } = pageWithProfileId; // Destructure id but ignore it
        await pageStore.add(pageToAdd); // Add new
      }
    }
    // Delete local pages not in synced data
    for (const [index, existingPage] of existingPageMap) {
      // existingPage is PageMetadata here
      if (!syncedPageIndices.has(index) && existingPage?.id) {
        // Check existingPage exists
        await pageStore.delete(existingPage.id);
      }
    }

    await tx.done;
    console.log(`Local data updated for profile ID: ${profileId}`);

    // Update last sync timestamp in localStorage
    localStorage.setItem(
      `lastSync_${profileId}`,
      (data._lastSyncTimestamp ?? Date.now()).toString(),
    );
  } catch (error) {
    console.error(`Error updating local data for profile ${profileId}:`, error);
    if (tx.error && !tx.done) {
      // Check if not already done before aborting
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
};

export const useGoogleDriveSync = () => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ItemConflict[]>([]);
  const [conflictData, setConflictData] = useState<{
    local: ProfileSyncData;
    remote: ProfileSyncData;
    fileId: string;
  } | null>(null);

  // Get the Google access token from the profile store
  const googleAccessToken = useProfileStore((state) => state.googleAccessToken);
  const isGoogleSignedIn = useProfileStore((state) => state.isGoogleSignedIn);

  // Log authentication state when the hook is initialized or auth state changes
  useEffect(() => {
    console.log(
      "useGoogleDriveSync - Auth State:",
      isGoogleSignedIn ? "Signed In" : "Not Signed In",
      googleAccessToken ? "(Token Present)" : "(No Token)",
    );
  }, [isGoogleSignedIn, googleAccessToken]);

  // --- Core API Functions ---

  // Find file by ID (useful for checking existence/metadata before download/upload)
  const findDriveFileById = useCallback(
    async (fileId: string): Promise<DriveFile | null> => {
      if (!googleAccessToken) throw new Error("Not signed in");
      try {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,appProperties,modifiedTime,kind`,
          { headers: { Authorization: `Bearer ${googleAccessToken}` } },
        );
        if (response.status === 404) return null; // File not found
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Google Drive API Error (findFileById): ${response.status} ${errorData?.error?.message || response.statusText}`,
          );
        }
        return await response.json();
      } catch (err) {
        console.error("Error finding Drive file by ID:", err);
        throw err;
      }
    },
    [googleAccessToken],
  );

  // Find file by name within user-visible space (needed for initial link/creation)
  const findDriveFileByName = useCallback(
    async (fileName: string): Promise<DriveFile | null> => {
      if (!googleAccessToken) throw new Error("Not signed in");
      try {
        // Search only for files created by this application using appProperties
        const query = `name='${fileName}' and mimeType='application/json' and 'appIdentifier' in appProperties and appProperties has { key='appIdentifier' and value='ImpAmp3' } and trashed=false`;
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,appProperties,modifiedTime,kind)`,
          { headers: { Authorization: `Bearer ${googleAccessToken}` } },
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Google Drive API Error (findFileByName): ${response.status} ${errorData?.error?.message || response.statusText}`,
          );
        }
        const data: DriveFileList = await response.json();
        return data.files && data.files.length > 0 ? data.files[0] : null; // Return first match
      } catch (err) {
        console.error("Error finding Drive file by name:", err);
        throw err;
      }
    },
    [googleAccessToken],
  );

  // List all files created by this app
  const listAppFiles = useCallback(async (): Promise<DriveFile[]> => {
    if (!googleAccessToken) throw new Error("Not signed in");
    try {
      const query = `'appIdentifier' in appProperties and appProperties has { key='appIdentifier' and value='ImpAmp3' } and trashed=false`;
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,appProperties,modifiedTime,kind)`,
        { headers: { Authorization: `Bearer ${googleAccessToken}` } },
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Google Drive API Error (listAppFiles): ${response.status} ${errorData?.error?.message || response.statusText}`,
        );
      }
      const data: DriveFileList = await response.json();
      return data.files || [];
    } catch (err) {
      console.error("Error listing app files:", err);
      throw err;
    }
  }, [googleAccessToken]);

  const downloadDriveFile = useCallback(
    async (fileId: string): Promise<ProfileSyncData | null> => {
      if (!googleAccessToken) throw new Error("Not signed in");
      try {
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { Authorization: `Bearer ${googleAccessToken}` } },
        );
        if (response.status === 404) return null;
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Google Drive API Error (download): ${response.status} ${errorData?.error?.message || response.statusText}`,
          );
        }
        const data = await response.json();
        // TODO: Add validation against ProfileSyncData interface shape
        return data as ProfileSyncData;
      } catch (err) {
        console.error(`Error downloading file ${fileId}:`, err);
        throw err;
      }
    },
    [googleAccessToken],
  );

  const uploadDriveFile = useCallback(
    async (
      fileName: string,
      jsonData: ProfileSyncData,
      existingFileId: string | null,
      profileId: number,
    ): Promise<DriveFile> => {
      if (!googleAccessToken) throw new Error("Not signed in");

      try {
        const metadata = {
          name: fileName,
          mimeType: "application/json",
          appProperties: {
            profileId: profileId.toString(),
            appIdentifier: "ImpAmp3",
          },
          // Only set parents when creating a *new* file
          ...(!existingFileId && { parents: ["root"] }),
        };
        const blob = new Blob([JSON.stringify(jsonData, null, 2)], {
          type: "application/json",
        });
        const form = new FormData();
        // IMPORTANT: Metadata MUST come before the file content in FormData for Drive API v3
        form.append(
          "metadata",
          new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        );
        form.append("file", blob);

        let uploadUrl: string;
        let method: string;

        if (existingFileId) {
          console.log(
            `Sync: Updating existing file: ${fileName} (ID: ${existingFileId})`,
          );
          uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
          method = "PATCH";
        } else {
          console.log(`Sync: Creating new file: ${fileName}`);
          uploadUrl = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,appProperties,modifiedTime,kind`;
          method = "POST";
        }

        const response = await fetch(uploadUrl, {
          method: method,
          headers: { Authorization: `Bearer ${googleAccessToken}` },
          body: form,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `Google Drive API Error (${method}): ${response.status} ${errorData?.error?.message || response.statusText}`,
          );
        }

        const uploadedFileData: DriveFile = await response.json();
        console.log(
          `Sync: File ${method === "POST" ? "created" : "updated"} successfully: ${uploadedFileData.name} (ID: ${uploadedFileData.id})`,
        );
        return uploadedFileData;
      } catch (err) {
        console.error(`Error uploading file ${fileName} to Google Drive:`, err);
        throw err;
      }
    },
    [googleAccessToken],
  );

  // --- Sync Logic ---

  const syncProfile = useCallback(
    async (profileId: number) => {
      setSyncStatus("syncing");
      setError(null);
      setConflicts([]);
      setConflictData(null);
      console.log(`Starting sync for profile ID: ${profileId}`);

      try {
        const localProfile = await getProfile(profileId);
        if (!localProfile)
          throw new Error(`Profile ${profileId} not found locally.`);
        if (localProfile.syncType !== "googleDrive") {
          console.log(
            `Profile ${profileId} is not set to Google Drive sync type.`,
          );
          setSyncStatus("idle"); // Not an error, just not applicable
          return { status: "skipped", reason: "Not a Google Drive profile" };
        }

        let fileId = localProfile.googleDriveFileId;
        let driveFile: DriveFile | null = null;

        // If linked, check if file still exists
        if (fileId) {
          driveFile = await findDriveFileById(fileId);
          if (!driveFile) {
            console.warn(
              `Linked Drive file ${fileId} not found for profile ${profileId}. Trying to find by name...`,
            );
            fileId = null; // Reset fileId as the link is broken
          }
        }

        // If not linked or link broken, try to find by name
        if (!fileId) {
          const fileName = getProfileSyncFilename(localProfile.name);
          driveFile = await findDriveFileByName(fileName);
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
            // Treat as initial upload scenario below
          }
        }

        // 1. Get Local Data
        const localData = await getLocalProfileSyncData(profileId);
        if (!localData) throw new Error("Could not load local profile data.");

        // 2. Get Remote Data (if file exists)
        const remoteData = fileId ? await downloadDriveFile(fileId) : null;

        // 3. Detect Conflicts & Merge
        const {
          conflicts: detectedConflicts,
          requiresManualResolution,
          mergedData,
        } = detectProfileConflicts(localData, remoteData);

        if (requiresManualResolution) {
          console.log(`Sync conflict detected for profile ${profileId}`);
          setConflicts(detectedConflicts);
          // Ensure remoteData is not null when setting conflictData
          if (remoteData && fileId) {
            setConflictData({
              local: localData,
              remote: remoteData,
              fileId: fileId,
            });
            setSyncStatus("conflict");
            setError("Sync conflicts detected. Manual resolution required.");
            return { status: "conflict", conflicts: detectedConflicts };
          } else {
            // Should not happen if requiresManualResolution is true, but handle defensively
            throw new Error("Conflict detected but remote data is missing.");
          }
        } else {
          // No conflicts, or automatically merged
          console.log(`Auto-merging/updating profile ${profileId}`);
          const driveFileName = getProfileSyncFilename(mergedData.profile.name);

          // Set the timestamp *before* uploading
          mergedData._lastSyncTimestamp = Date.now();

          // 4. Upload Merged Data to Drive (Create or Update)
          // Ensure fileId is strictly string | null before passing
          const uploadedFile = await uploadDriveFile(
            driveFileName,
            mergedData,
            fileId ?? null,
            profileId,
          );

          // 5. Update Local Data with Merged Data
          await updateLocalData(profileId, mergedData);

          // 6. Ensure local profile has the correct file ID
          if (uploadedFile.id !== fileId) {
            await updateProfile(profileId, {
              googleDriveFileId: uploadedFile.id,
            });
          }

          setSyncStatus("success");
          console.log(`Profile ${profileId} synced successfully.`);
          return { status: "success", data: mergedData };
        }
      } catch (err) {
        console.error(`Sync failed for profile ${profileId}:`, err);
        const message =
          err instanceof Error
            ? err.message
            : "An unknown sync error occurred.";
        setError(message);
        setSyncStatus("error");
        return { status: "error", error: message };
      }
    },
    [
      googleAccessToken,
      downloadDriveFile,
      uploadDriveFile,
      findDriveFileById,
      findDriveFileByName,
    ],
  ); // Added find dependencies

  // Function to apply resolved data after user interaction
  const applyConflictResolution = useCallback(
    async (
      resolvedData: ProfileSyncData,
      fileId: string,
      profileId: number,
    ) => {
      setSyncStatus("syncing");
      setError(null);
      setConflicts([]);
      setConflictData(null);

      try {
        resolvedData._lastSyncTimestamp = Date.now(); // Set final sync timestamp
        const driveFileName = getProfileSyncFilename(resolvedData.profile.name);
        const uploadedFile = await uploadDriveFile(
          driveFileName,
          resolvedData,
          fileId,
          profileId,
        );
        await updateLocalData(profileId, resolvedData);

        if (uploadedFile.id !== fileId) {
          await updateProfile(profileId, {
            googleDriveFileId: uploadedFile.id,
          });
        }

        setSyncStatus("success");
        console.log(
          `Conflict resolution applied successfully for profile ${profileId}`,
        );
        return { status: "success", data: resolvedData };
      } catch (err) {
        console.error(
          `Failed to apply conflict resolution for profile ${profileId}:`,
          err,
        );
        const message =
          err instanceof Error ? err.message : "Failed to apply resolved data.";
        setError(message);
        setSyncStatus("error");
        return { status: "error", error: message };
      }
    },
    [googleAccessToken, uploadDriveFile],
  );

  return {
    syncStatus,
    error,
    conflicts,
    conflictData,
    syncProfile,
    applyConflictResolution,
    // Also return the helper functions needed by the UI
    listAppFiles, // Return the new function
    downloadDriveFile,
    uploadDriveFile,
    findDriveFileById, // Might be useful for ProfileCard logic later
    findDriveFileByName,
  };
};
