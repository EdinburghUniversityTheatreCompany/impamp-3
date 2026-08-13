/**
 * Synchronization logic for Google Drive integration
 * Handles profile syncing, conflict resolution, and error handling
 */

import {
  updateProfile,
  getProfile,
  getDb,
  getAudioFileIdsForProfile,
  getAudioFile,
  addAudioFile,
  updateAudioFileDriveId,
  getAudioFileByHash,
  ensureAudioFileHash,
} from "@/lib/db";
import { detectProfileConflicts } from "@/lib/syncUtils";
import { getProfileSyncFilename, updateSyncTimestamp } from "./utils";
import {
  getLocalProfileSyncData,
  updateLocalData,
  backfillDriveFileIdsFromRemote,
} from "./dataAccess";
import {
  downloadDriveFile,
  downloadPublicProfileData,
  findDriveFileById,
  findDriveFileByName,
  findAudioFileInDriveFolder,
  uploadDriveFile,
  uploadAudioFile,
  downloadAudioFileAsBlob,
  getOrCreateProfileFolder,
  getFolderCapabilities,
  moveFileToFolder,
  listDriveFilesByQuery,
} from "./api";
import {
  ProfileSyncData,
  SyncStatus,
  SyncResult,
  SyncConflictData,
  TokenInfo,
  ItemConflict,
} from "./types";

/**
 * Verify all audio files for a profile exist in Drive, uploading any that are
 * missing (no driveFileId) or whose Drive file has been deleted (stale driveFileId).
 * Updates IndexedDB records with new Drive file IDs as needed.
 */
export async function repairDriveAudioFiles(
  profileId: number,
  tokenInfo: TokenInfo,
  refreshCallback: (token: TokenInfo) => void,
  folderId?: string,
): Promise<{ checked: number; uploaded: number; errors: string[] }> {
  const audioFileIds = await getAudioFileIdsForProfile(profileId);
  let checked = 0;
  let uploaded = 0;
  const errors: string[] = [];

  for (const id of audioFileIds) {
    const audioFile = await getAudioFile(id);
    if (!audioFile) continue;
    checked++;

    let needsUpload = false;
    const existingDriveId = audioFile.driveFileIds?.[profileId];

    if (!existingDriveId) {
      needsUpload = true;
    } else {
      const existing = await findDriveFileById(
        existingDriveId,
        tokenInfo,
        refreshCallback,
      );
      if (!existing) {
        console.log(
          `Audio file "${audioFile.name}" missing from Drive — will re-upload`,
        );
        needsUpload = true;
      } else if (folderId && !existing.parents?.includes(folderId)) {
        console.log(
          `Audio file "${audioFile.name}" exists in Drive but not in profile folder — will re-upload`,
        );
        needsUpload = true;
      }
    }

    if (!needsUpload) continue;

    // Before uploading, check if another browser already uploaded this file to the folder
    if (folderId) {
      try {
        const existing = await findAudioFileInDriveFolder(
          audioFile.name,
          profileId,
          folderId,
          tokenInfo,
          refreshCallback,
        );
        if (existing) {
          console.log(
            `Audio file "${audioFile.name}" already exists in Drive folder — recording ID without re-uploading`,
          );
          await updateAudioFileDriveId(id, existing.id, profileId);
          continue;
        }
      } catch (err) {
        console.warn(
          `Could not check Drive for existing "${audioFile.name}" — will upload:`,
          err,
        );
      }
    }

    try {
      const driveFile = await uploadAudioFile(
        audioFile.name,
        audioFile.blob,
        audioFile.type,
        null,
        profileId,
        tokenInfo,
        refreshCallback,
        folderId,
      );
      await updateAudioFileDriveId(id, driveFile.id, profileId);
      uploaded++;
      console.log(
        `Repaired audio file "${audioFile.name}" → Drive ID: ${driveFile.id}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`"${audioFile.name}": ${msg}`);
      console.error(`Failed to repair audio file "${audioFile.name}":`, err);
    }
  }

  return { checked, uploaded, errors };
}

/**
 * Upload any audio files for a profile that don't yet have a Drive file ID.
 * Updates the IndexedDB record with the returned Drive file ID.
 */
export async function uploadMissingAudioFiles(
  profileId: number,
  tokenInfo: TokenInfo,
  refreshCallback: (token: TokenInfo) => void,
  folderId?: string,
): Promise<void> {
  const audioFileIds = await getAudioFileIdsForProfile(profileId);
  for (const id of audioFileIds) {
    const audioFile = await getAudioFile(id);
    if (!audioFile) continue;
    if (audioFile.driveFileIds?.[profileId]) {
      console.log(
        `Audio file "${audioFile.name}" already on Drive for profile ${profileId} — skipping upload`,
      );
      continue;
    }
    try {
      const driveFile = await uploadAudioFile(
        audioFile.name,
        audioFile.blob,
        audioFile.type,
        null,
        profileId,
        tokenInfo,
        refreshCallback,
        folderId,
      );
      await updateAudioFileDriveId(id, driveFile.id, profileId);
      console.log(
        `Uploaded audio file "${audioFile.name}" → Drive ID: ${driveFile.id}`,
      );
    } catch (err) {
      console.error(`Failed to upload audio file "${audioFile.name}":`, err);
      // Non-fatal: continue syncing other files; profile JSON will omit driveFileId for this one
    }
  }
}

/**
 * Migrate a profile from the flat ImpAmp_Data layout to a per-profile folder.
 * Moves the existing profile JSON and any Drive audio files into the new folder.
 * Returns the new folder ID.
 */
async function migrateToFolderLayout(
  profileId: number,
  profileName: string,
  fileId: string,
  tokenInfo: TokenInfo,
  refreshCallback: (token: TokenInfo) => void,
): Promise<string> {
  console.log(`Migrating profile ${profileId} to folder layout…`);

  const folderId = await getOrCreateProfileFolder(
    profileName,
    tokenInfo,
    refreshCallback,
  );

  // Move the profile JSON into the folder
  await moveFileToFolder(fileId, folderId, tokenInfo, refreshCallback);
  console.log(`Moved profile JSON ${fileId} → folder ${folderId}`);

  // Find and move audio files for this profile that are in Drive
  try {
    const query = `appProperties has { key='profileId' and value='${profileId}' } and appProperties has { key='fileType' and value='audioFile' } and trashed=false`;
    const files = await listDriveFilesByQuery(
      query,
      "id,name",
      tokenInfo,
      refreshCallback,
    );
    for (const f of files) {
      try {
        await moveFileToFolder(f.id, folderId, tokenInfo, refreshCallback);
        console.log(`Moved audio file "${f.name}" → folder ${folderId}`);
      } catch (err) {
        console.error(`Failed to move audio file "${f.name}":`, err);
      }
    }
  } catch (err) {
    console.error("Failed to list/move audio files during migration:", err);
    // Non-fatal — files are still accessible from the old location
  }

  // Persist the new folder ID
  await updateProfile(profileId, { googleDriveFolderId: folderId });
  console.log(
    `Migration complete for profile ${profileId}, folder: ${folderId}`,
  );
  return folderId;
}

/**
 * Download any audio files referenced in remote sync data that are missing locally.
 * Stores downloaded files in IndexedDB with their Drive file ID set.
 *
 * Server sync uses this too: audio stays in Drive under both backends, so a
 * collaborator pulling from the server still fetches the bytes from Drive —
 * with a null token falling back to the public proxy for anonymous viewers.
 *
 * @returns Warnings about files gone from Drive, plus any retryable failures
 */
export async function downloadMissingAudioFiles(
  audioRefs: ProfileSyncData["audioFiles"],
  profileId: number,
  tokenInfo: TokenInfo | null,
  refreshCallback: (token: TokenInfo) => void,
): Promise<{ warnings: string[]; retryable: string[] }> {
  const warnings: string[] = [];
  const retryable: string[] = [];
  if (!audioRefs || audioRefs.length === 0) return { warnings, retryable };

  // Hashes for local files that predate hashing, built once and only if a
  // reference actually misses the hash index — the blobs are read one at a
  // time so the whole audio library never sits in memory at once.
  let hashlessIndex: Map<string, number> | null = null;
  const getHashlessIndex = async (): Promise<Map<string, number>> => {
    if (hashlessIndex) return hashlessIndex;
    hashlessIndex = new Map();
    const db = await getDb();
    const localIds = await db.getAllKeys("audioFiles");
    for (const localId of localIds) {
      const computedHash = await ensureAudioFileHash(localId);
      if (computedHash) hashlessIndex.set(computedHash, localId);
    }
    return hashlessIndex;
  };

  for (const ref of audioRefs) {
    if (!ref.driveFileId) continue; // legacy base64 ref — handled by updateLocalData

    // Hash-first deduplication: check by content hash if available
    let existingFile = ref.hash
      ? await getAudioFileByHash(ref.hash)
      : undefined;

    // If no hash match, local files without a stored hash may still be the same
    // audio — hash them once and retry the lookup
    if (!existingFile && ref.hash) {
      const localId = (await getHashlessIndex()).get(ref.hash);
      if (localId !== undefined) {
        existingFile = await getAudioFile(localId);
      }
    }

    if (existingFile) {
      // Backfill driveFileId for this profile if missing
      if (
        !existingFile.driveFileIds?.[profileId] &&
        existingFile.id !== undefined
      ) {
        await updateAudioFileDriveId(
          existingFile.id,
          ref.driveFileId,
          profileId,
        );
      }
      console.log(
        `Audio file "${ref.name}" already exists locally (hash match)`,
      );
      continue;
    }

    try {
      const blob = await downloadAudioFileAsBlob(
        ref.driveFileId,
        tokenInfo,
        refreshCallback,
      );
      if (blob) {
        await addAudioFile({
          blob,
          name: ref.name,
          type: ref.type,
          hash: ref.hash,
          driveFileIds: { [profileId]: ref.driveFileId },
        });
        console.log(`Downloaded audio file "${ref.name}" from Drive`);
      } else {
        // Gone from Drive for good — pads referencing it lose the reference
        warnings.push(
          `Audio file "${ref.name}" is no longer available in Drive`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to download audio file "${ref.name}" from Drive:`,
        err,
      );
      // Could succeed later; the caller aborts rather than dropping the pad audio
      retryable.push(`"${ref.name}": ${msg}`);
    }
  }

  return { warnings, retryable };
}

/**
 * Pull a read-only profile from Drive via the public proxy and apply it
 * locally. Used when there is no Google sign-in, or when the signed-in
 * user's drive.file token cannot see the profile's Drive file (a public
 * profile connected via share URL without a Picker grant).
 *
 * The profile is read-only, so no local edits can exist: remote wins
 * outright and nothing is ever written back to Drive.
 */
async function pullPublicReadOnlyProfile(
  profileId: number,
  fileId: string,
  onStatusChange: (status: SyncStatus) => void,
  onError: (error: string | null) => void,
): Promise<SyncResult> {
  console.log(
    `Pulling read-only profile ${profileId} via public proxy (file ${fileId})...`,
  );

  const remoteData = await downloadPublicProfileData(fileId);
  if (!remoteData) {
    const message =
      "This shared profile is not publicly accessible. Ask the owner to " +
      'share it with "anyone with the link", or sign in with an invited ' +
      "Google account.";
    onError(message);
    onStatusChange("error");
    return { status: "error", error: message };
  }

  // Fetch any audio we don't have yet through the public proxy (token = null)
  if (remoteData.audioFiles) {
    const { retryable } = await downloadMissingAudioFiles(
      remoteData.audioFiles,
      profileId,
      null,
      () => {},
    );
    // A transient failure here must postpone the pull: applying the profile
    // without the audio would strip those pad references locally until the
    // next successful pull.
    if (retryable.length > 0) {
      const message = `Could not download audio for this shared profile: ${retryable.join("; ")}`;
      onError(message);
      onStatusChange("error");
      return { status: "error", error: message };
    }
  }

  remoteData._lastSyncTimestamp = Date.now();
  const warnings = await updateLocalData(profileId, remoteData);
  if (warnings.length > 0) {
    onError(warnings.join("\n"));
  }

  onStatusChange("success");
  console.log(`Read-only profile ${profileId} pulled via public proxy.`);
  return { status: "success", data: remoteData };
}

/**
 * Interface for sync status callbacks
 */
interface SyncStatusCallbacks {
  onStatusChange: (status: SyncStatus) => void;
  onError: (error: string | null) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
  onConflictDataAvailable: (data: SyncConflictData | null) => void;
}

/**
 * Syncs currently running, keyed by profile ID. Sign-in, the online event, the
 * debounce, the periodic timer and manual syncs can all fire at once; without
 * this the last writer would clobber the others both locally and in Drive.
 */
const inFlightSyncs = new Map<number, Promise<SyncResult>>();

/**
 * Synchronize a profile with Google Drive.
 * Concurrent calls for the same profile share the in-flight run.
 * @param profileId The profile ID to sync
 * @param tokenInfo Current token information
 * @param callbacks Status update callbacks
 * @param refreshCallback Callback to update token if refreshed
 * @returns The sync result
 */
export const syncProfile = (
  profileId: number,
  tokenInfo: TokenInfo | null,
  callbacks: SyncStatusCallbacks,
  refreshCallback: (token: TokenInfo) => void,
): Promise<SyncResult> => {
  const inFlight = inFlightSyncs.get(profileId);
  if (inFlight) {
    console.log(
      `Sync already running for profile ${profileId} — joining in-flight run`,
    );
    return inFlight;
  }

  const run = performProfileSync(
    profileId,
    tokenInfo,
    callbacks,
    refreshCallback,
  ).finally(() => {
    inFlightSyncs.delete(profileId);
  });

  inFlightSyncs.set(profileId, run);
  return run;
};

const performProfileSync = async (
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
    let localProfile = await getProfile(profileId);
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
      // No sign-in needed for read-only profiles that are publicly shared:
      // pull them through the server-side proxy instead.
      if (localProfile.readOnly && localProfile.googleDriveFileId) {
        return await pullPublicReadOnlyProfile(
          profileId,
          localProfile.googleDriveFileId,
          onStatusChange,
          onError,
        );
      }
      onStatusChange("error");
      onError("Not authenticated with Google Drive");
      return {
        status: "error",
        error: "Not authenticated with Google Drive",
      };
    }

    let fileId = localProfile.googleDriveFileId;
    let folderId = localProfile.googleDriveFolderId ?? null;
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

    // A read-only profile whose Drive file is invisible to this account is a
    // publicly shared profile connected via URL (drive.file has no grant on
    // it). Pull it through the public proxy — do NOT fall through to the
    // name-lookup/initial-upload path, which would wrongly create a folder in
    // this user's own Drive and flip the profile to read-write.
    if (!fileId && localProfile.readOnly && localProfile.googleDriveFileId) {
      return await pullPublicReadOnlyProfile(
        profileId,
        localProfile.googleDriveFileId,
        onStatusChange,
        onError,
      );
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

    // Resolve per-profile folder
    if (!folderId) {
      if (fileId) {
        // Migration: existing flat-layout profile → move into a folder
        folderId = await migrateToFolderLayout(
          profileId,
          localProfile.name,
          fileId,
          tokenInfo,
          refreshCallback,
        );
      } else {
        // New profile: create the folder now so audio and JSON land in it
        folderId = await getOrCreateProfileFolder(
          localProfile.name,
          tokenInfo,
          refreshCallback,
        );
        await updateProfile(profileId, { googleDriveFolderId: folderId });
      }
    }

    // Reconcile readOnly against actual Drive folder permissions
    try {
      const capability = await getFolderCapabilities(
        folderId,
        tokenInfo,
        refreshCallback,
      );
      const shouldBeReadOnly = capability === "reader";
      const shouldBeReadWrite =
        capability === "owner" || capability === "writer";
      if (shouldBeReadOnly && !localProfile.readOnly) {
        console.log(
          `Profile ${profileId}: Drive access is read-only — setting readOnly=true`,
        );
        await updateProfile(profileId, { readOnly: true });
        localProfile = { ...localProfile, readOnly: true };
      } else if (shouldBeReadWrite && localProfile.readOnly) {
        console.log(
          `Profile ${profileId}: Drive access upgraded to write — setting readOnly=false`,
        );
        await updateProfile(profileId, { readOnly: false });
        localProfile = { ...localProfile, readOnly: false };
      }
    } catch (err) {
      console.warn(
        `Could not determine folder capabilities for profile ${profileId}:`,
        err,
      );
      // Non-fatal: fall back to existing readOnly value
    }

    // 1. Get Remote Data (if file exists)
    const remoteData = fileId
      ? await downloadDriveFile(fileId, tokenInfo, refreshCallback)
      : null;

    // 1a. Backfill driveFileIds from remote JSON into local audio file records so
    //     that uploadMissingAudioFiles skips files already on Drive without needing
    //     an extra Drive API search query per file.
    if (remoteData?.audioFiles) {
      await backfillDriveFileIdsFromRemote(remoteData.audioFiles, profileId);
    }

    // 1b. Upload any audio files that still don't have a Drive file ID (genuinely new)
    if (!localProfile.readOnly) {
      await uploadMissingAudioFiles(
        profileId,
        tokenInfo,
        refreshCallback,
        folderId,
      );
    }

    // 1c. Get Local Data (now that audio files have driveFileIds set)
    const localData = await getLocalProfileSyncData(profileId);
    if (!localData) {
      throw new Error("Could not load local profile data.");
    }

    // 1d. Download any audio files referenced in remote data that we don't have locally
    const warnings: string[] = [];
    if (remoteData?.audioFiles) {
      const downloads = await downloadMissingAudioFiles(
        remoteData.audioFiles,
        profileId,
        tokenInfo,
        refreshCallback,
      );
      warnings.push(...downloads.warnings);

      // Merging now would clear every pad pointing at a file we failed to fetch,
      // and the next sync would push that loss to Drive. Retry instead.
      if (downloads.retryable.length > 0) {
        throw new Error(
          `Could not download ${downloads.retryable.length} audio file(s) from Drive — sync postponed: ${downloads.retryable.join("; ")}`,
        );
      }
    }

    // 3. Detect Conflicts & Merge
    const {
      conflicts: detectedConflicts,
      requiresManualResolution,
      mergedData,
    } = await detectProfileConflicts(localData, remoteData);

    if (requiresManualResolution) {
      console.log(`Sync conflict detected for profile ${profileId}`);
      onConflictsDetected(detectedConflicts);

      // Ensure remoteData is not null when setting conflictData
      if (remoteData && fileId) {
        // mergedData carries every automatically resolved change (remote field
        // wins, remote-only additions). It is the base the resolution builds on;
        // resolving from local alone would silently drop all of it.
        const conflictData: SyncConflictData = {
          local: localData,
          remote: remoteData,
          merged: mergedData,
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

      mergedData._lastSyncTimestamp = Date.now();

      if (localProfile.readOnly) {
        // Read-only: apply remote changes locally but never write back to Drive
        console.log(`Profile ${profileId} is read-only — skipping upload.`);
        warnings.push(...(await updateLocalData(profileId, mergedData)));
      } else {
        // 4. Upload Merged Data to Drive (Create or Update)
        const driveFileName = getProfileSyncFilename(mergedData.profile.name);
        const uploadedFile = await uploadDriveFile(
          driveFileName,
          mergedData,
          fileId !== undefined ? fileId : null,
          profileId,
          tokenInfo,
          refreshCallback,
          folderId ?? undefined,
        );

        // 5. Update Local Data with Merged Data
        warnings.push(...(await updateLocalData(profileId, mergedData)));

        // 6. Ensure local profile has the correct file ID
        if (uploadedFile.id !== fileId) {
          await updateProfile(profileId, {
            googleDriveFileId: uploadedFile.id,
          });
        }
      }

      onStatusChange("success");
      console.log(`Profile ${profileId} synced successfully.`);
      if (warnings.length > 0) {
        console.warn(`Profile ${profileId} synced with warnings:`, warnings);
        onError(warnings.join("\n"));
      }
      return {
        status: "success",
        data: mergedData,
        ...(warnings.length > 0 ? { warnings } : {}),
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
  fileId: string | null, // Allow fileId to be null to match uploadDriveFile parameter type
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

    // Keep everything inside the profile's folder, as syncProfile does — files
    // uploaded to the app root are invisible to folder-scoped collaborators
    const profile = await getProfile(profileId);
    const folderId = profile?.googleDriveFolderId ?? undefined;

    // Upload any audio files that don't have a Drive file ID yet
    await uploadMissingAudioFiles(
      profileId,
      tokenInfo,
      refreshCallback,
      folderId,
    );

    // Set a fresh timestamp for the resolution
    resolvedData._lastSyncTimestamp = Date.now();

    // Generate the filename based on profile name
    const driveFileName = getProfileSyncFilename(resolvedData.profile.name);

    // Upload the resolved data to Drive
    // Ensure fileId is explicitly string or null, never undefined
    const fileIdSafe: string | null = fileId === undefined ? null : fileId;
    const uploadedFile = await uploadDriveFile(
      driveFileName,
      resolvedData,
      fileIdSafe,
      profileId,
      tokenInfo,
      refreshCallback,
      folderId,
    );

    // Update local data with the resolved data
    const warnings = await updateLocalData(profileId, resolvedData);

    // Ensure the profile has the correct file ID
    if (uploadedFile.id !== fileId) {
      await updateProfile(profileId, {
        googleDriveFileId: uploadedFile.id,
      });
    }

    // Update the sync timestamp
    updateSyncTimestamp(
      profileId,
      resolvedData._lastSyncTimestamp ?? Date.now(),
    );

    onStatusChange("success");
    console.log(
      `Conflict resolution applied successfully for profile ${profileId}`,
    );
    if (warnings.length > 0) {
      console.warn(
        `Conflict resolution for profile ${profileId} produced warnings:`,
        warnings,
      );
      onError(warnings.join("\n"));
    }

    return {
      status: "success",
      data: resolvedData,
      ...(warnings.length > 0 ? { warnings } : {}),
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
