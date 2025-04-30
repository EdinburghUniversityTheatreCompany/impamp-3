/**
 * Data access functions for Google Drive integration
 * Handles all IndexedDB and local storage operations
 */

import {
  PadConfiguration,
  PageMetadata,
  getProfile,
  updateProfile,
  getDb,
  getAudioFile,
} from "@/lib/db";
import { ProfileSyncData } from "@/lib/syncUtils";
import { blobToBase64, base64ToBlob } from "@/lib/importExport";
import { updateSyncTimestamp } from "./utils";

/**
 * Gathers all data for a specific profile from IndexedDB
 * @param profileId The profile ID
 * @returns The profile data or null if not found
 */
export const getLocalProfileSyncData = async (
  profileId: number,
): Promise<ProfileSyncData | null> => {
  if (typeof window === "undefined") return null;

  const db = await getDb();
  const profile = await getProfile(profileId);
  if (!profile) return null;

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

  // Get all unique audio file IDs
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
        `Audio file with ID ${audioFileId} referenced but not found`,
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

/**
 * Updates the local database with data from a sync operation
 * @param profileId The profile ID to update
 * @param data The sync data to apply
 */
export const updateLocalData = async (
  profileId: number,
  data: ProfileSyncData,
): Promise<void> => {
  if (typeof window === "undefined") return;

  const db = await getDb();

  // First, handle audio files import
  const audioIdMap = new Map<number, number>();

  if (data.audioFiles && data.audioFiles.length > 0) {
    try {
      console.log(`Importing ${data.audioFiles.length} audio files`);

      // Create a separate transaction for audio files
      const audioTx = db.transaction(["audioFiles"], "readwrite");
      const audioStore = audioTx.objectStore("audioFiles");

      for (const audioFileData of data.audioFiles) {
        // Check if audio file already exists
        const existingAudioFiles = await audioStore
          .index("name")
          .getAll(audioFileData.name);
        let newAudioId: number;

        if (existingAudioFiles.length > 0) {
          // Use the first matching audio file
          newAudioId = existingAudioFiles[0].id as number;
          console.log(`Using existing audio file "${audioFileData.name}"`);
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
          console.log(`Added new audio file "${audioFileData.name}"`);
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
    const existingPads = await padStore.index("profileId").getAll(profileId);
    const existingPadMap = new Map(
      existingPads.map((p: PadConfiguration) => [
        `${p.pageIndex}-${p.padIndex}`,
        p,
      ]),
    );
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
          .map((id) => audioIdMap.get(id) || id)
          .filter((id) => typeof id === "number");
      }

      // Check if pad exists locally
      const existingLocalPad = (await padCompoundIndex.get([
        profileId,
        pad.pageIndex,
        pad.padIndex,
      ])) as PadConfiguration | undefined;

      if (existingLocalPad?.id) {
        await padStore.put({ ...padWithProfileId, id: existingLocalPad.id });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _remoteId, ...padToAdd } = padWithProfileId;
        await padStore.add(padToAdd);
      }
    }

    // Delete local pads that are not in the synced data
    for (const [padKey, existingPad] of existingPadMap) {
      if (!syncedPadKeys.has(padKey) && existingPad.id) {
        await padStore.delete(existingPad.id);
      }
    }

    // 3. Update Page Metadata (Upsert/Delete logic)
    const existingPages = await pageStore.index("profileId").getAll(profileId);
    const existingPageMap = new Map(
      existingPages.map((p: PageMetadata) => [p.pageIndex, p]),
    );
    const syncedPageIndices = new Set<number>();

    for (const page of data.pageMetadata) {
      syncedPageIndices.add(page.pageIndex);
      const pageWithProfileId = { ...page, profileId: profileId };
      const existingLocalPage = (await pageCompoundIndex.get([
        profileId,
        page.pageIndex,
      ])) as PageMetadata | undefined;

      if (existingLocalPage?.id) {
        await pageStore.put({ ...pageWithProfileId, id: existingLocalPage.id });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _remoteId, ...pageToAdd } = pageWithProfileId;
        await pageStore.add(pageToAdd);
      }
    }

    // Delete local pages not in synced data
    for (const [index, existingPage] of existingPageMap) {
      if (!syncedPageIndices.has(index) && existingPage?.id) {
        await pageStore.delete(existingPage.id);
      }
    }

    await tx.done;
    console.log(`Local data updated for profile ID: ${profileId}`);

    // Update last sync timestamp in localStorage
    updateSyncTimestamp(profileId, data._lastSyncTimestamp ?? Date.now());
  } catch (error) {
    console.error(`Error updating local data for profile ${profileId}:`, error);
    if (tx.error && !tx.done) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
};
