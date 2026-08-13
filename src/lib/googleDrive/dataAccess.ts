/**
 * Data access functions for Google Drive integration
 * Handles all IndexedDB and local storage operations
 */

import {
  AudioFile,
  PadConfiguration,
  PageMetadata,
  getProfile,
  getDb,
  getAudioFile,
  ensureAudioFileHash,
  updateAudioFileDriveId,
  collectReferencedAudioFileIds,
  computeBlobHash,
} from "@/lib/db";
import { ProfileSyncData } from "@/lib/syncUtils";
import { base64ToBlob } from "@/lib/importExport";
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
  const audioFileIds = collectReferencedAudioFileIds(padConfigurations);

  // Build audio file references — use driveFileId if available, otherwise omit
  // (uploadMissingAudioFiles in sync.ts ensures driveFileIds are set before this is called)
  const audioFiles = [];
  for (const audioFileId of audioFileIds) {
    const audioFile = await getAudioFile(audioFileId);
    if (audioFile) {
      audioFiles.push({
        id: audioFileId,
        name: audioFile.name,
        type: audioFile.type,
        hash: (await ensureAudioFileHash(audioFileId)) ?? undefined,
        driveFileId: audioFile.driveFileIds?.[profileId],
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
 * Resolves a remote audio reference to the local record holding the same audio.
 * Content hashes are authoritative; names are only consulted for legacy entries
 * that predate hashing, and then only when the match is unambiguous.
 * @param ref The remote reference (name plus optional content hash)
 * @param getByHash Index lookup by hash
 * @param getByName Index lookup by name
 * @returns The matching local record, or undefined if none can be trusted
 */
const findLocalAudioMatch = async (
  ref: { name: string; hash?: string },
  getByHash: (hash: string) => Promise<AudioFile[]>,
  getByName: (name: string) => Promise<AudioFile[]>,
): Promise<AudioFile | undefined> => {
  if (ref.hash) {
    const hashMatches = await getByHash(ref.hash);
    // A hash miss means any same-named local file holds different audio
    return hashMatches[0];
  }

  const nameMatches = await getByName(ref.name);
  if (nameMatches.length !== 1) return undefined;
  return nameMatches[0].hash ? undefined : nameMatches[0];
};

/**
 * JSON round-trips turn Date fields into strings. IndexedDB records must keep
 * real Date objects, so coerce anything that came back through JSON.parse.
 */
const toDate = (value: unknown): Date => {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
};

/**
 * Backfills driveFileIds from remote sync data into local audio file records.
 * Called before uploading so that files already on Drive (per the remote JSON)
 * are not re-uploaded.
 */
export const backfillDriveFileIdsFromRemote = async (
  audioRefs:
    | { id: number; name: string; hash?: string; driveFileId?: string }[]
    | undefined,
  profileId: number,
): Promise<void> => {
  if (!audioRefs || audioRefs.length === 0) return;

  const db = await getDb();

  // Resolve every reference in a single read-only pass. The writes must wait
  // until this transaction is done — awaiting a separate transaction inside it
  // lets it auto-commit, and the next read then throws TransactionInactiveError.
  const pendingWrites: { localId: number; driveFileId: string }[] = [];
  const tx = db.transaction("audioFiles", "readonly");
  const audioStore = tx.objectStore("audioFiles");

  for (const ref of audioRefs) {
    if (!ref.driveFileId) continue;

    const local = await findLocalAudioMatch(
      ref,
      (hash) => audioStore.index("hash").getAll(hash),
      (name) => audioStore.index("name").getAll(name),
    );
    if (!local || local.id === undefined) continue;
    if (local.driveFileIds?.[profileId]) continue;

    pendingWrites.push({ localId: local.id, driveFileId: ref.driveFileId });
  }

  await tx.done;

  for (const { localId, driveFileId } of pendingWrites) {
    await updateAudioFileDriveId(localId, driveFileId, profileId);
  }
};

/**
 * Updates the local database with data from a sync operation
 * @param profileId The profile ID to update
 * @param data The sync data to apply
 * @returns Warnings about references that could not be preserved
 */
export const updateLocalData = async (
  profileId: number,
  data: ProfileSyncData,
): Promise<string[]> => {
  if (typeof window === "undefined") return [];

  const db = await getDb();
  const warnings: string[] = [];

  // First, handle audio files import
  const audioIdMap = new Map<number, number>();
  const hasAudioReferences = !!(data.audioFiles && data.audioFiles.length > 0);

  if (hasAudioReferences) {
    console.log(`Importing ${data.audioFiles.length} audio files`);

    // Decode legacy base64 payloads and derive their hashes up front: awaiting
    // work that isn't an IndexedDB request would close the transaction below.
    const prepared: {
      ref: ProfileSyncData["audioFiles"][number];
      blob?: Blob;
      hash?: string;
    }[] = [];
    for (const audioFileData of data.audioFiles) {
      let blob: Blob | undefined;
      let hash = audioFileData.hash;
      if (audioFileData.data) {
        blob = await base64ToBlob(audioFileData.data, audioFileData.type);
        hash = hash ?? (await computeBlobHash(blob));
      }
      prepared.push({ ref: audioFileData, blob, hash });
    }

    // Create a separate transaction for audio files
    const audioTx = db.transaction(["audioFiles"], "readwrite");
    const audioStore = audioTx.objectStore("audioFiles");

    for (const { ref, blob, hash } of prepared) {
      // Match on content hash so same-named different recordings stay distinct
      const existing = await findLocalAudioMatch(
        { name: ref.name, hash },
        (h) => audioStore.index("hash").getAll(h),
        (n) => audioStore.index("name").getAll(n),
      );
      let newAudioId: number;

      if (existing?.id !== undefined) {
        newAudioId = existing.id;
        // Persist the driveFileId for this profile if we now know it and it's missing
        if (ref.driveFileId && !existing.driveFileIds?.[profileId]) {
          const currentMap = existing.driveFileIds ?? {};
          await audioStore.put({
            ...existing,
            driveFileIds: { ...currentMap, [profileId]: ref.driveFileId },
          });
        }
        console.log(`Using existing audio file "${ref.name}"`);
      } else if (blob) {
        // Legacy path: base64-encoded data present — store the decoded blob
        newAudioId = await audioStore.add({
          blob,
          name: ref.name,
          type: ref.type,
          hash,
          driveFileIds: ref.driveFileId
            ? { [profileId]: ref.driveFileId }
            : undefined,
          createdAt: new Date(),
        });
        console.log(`Added audio file from base64 "${ref.name}"`);
      } else {
        // New path: driveFileId only — the file should have been pre-downloaded by
        // downloadMissingAudioFiles in sync.ts. Leaving it out of the ID map makes
        // referencing pads drop the reference instead of pointing at another sound.
        warnings.push(
          `Audio file "${ref.name}" is unavailable locally — pads referencing it were cleared`,
        );
        continue;
      }

      // Map original ID to new local ID
      audioIdMap.set(ref.id, newAudioId);
    }

    await audioTx.done;
    console.log(`Audio files import complete, mapped ${audioIdMap.size} files`);
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
    // 1. Update Profile — preserve local-only fields that must not be overwritten by remote
    const existingLocalProfile = await profileStore.get(profileId);
    const profileWithId = {
      ...data.profile,
      id: profileId,
      name: existingLocalProfile?.name ?? data.profile.name,
      readOnly: existingLocalProfile?.readOnly ?? data.profile.readOnly,
      syncType: existingLocalProfile?.syncType ?? data.profile.syncType,
      googleDriveFileId:
        existingLocalProfile?.googleDriveFileId ??
        data.profile.googleDriveFileId,
      syncPausedUntil:
        existingLocalProfile?.syncPausedUntil ?? data.profile.syncPausedUntil,
      createdAt: toDate(existingLocalProfile?.createdAt ?? data.profile.createdAt),
      updatedAt: toDate(data.profile.updatedAt),
    };
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
      const padWithProfileId = {
        ...pad,
        profileId: profileId,
        createdAt: toDate(pad.createdAt),
        updatedAt: toDate(pad.updatedAt),
      };

      // Translate the synced audio IDs into local IDs. Anything that cannot be
      // resolved is dropped — an untranslated ID would address a different
      // local recording, so a silent pad is the safer outcome.
      if (hasAudioReferences && padWithProfileId.audioFileIds?.length) {
        const resolvedIds: number[] = [];
        for (const syncedId of padWithProfileId.audioFileIds) {
          const localId = audioIdMap.get(syncedId);
          if (localId === undefined) {
            warnings.push(
              `Pad ${pad.pageIndex}-${pad.padIndex}: dropped unresolved audio reference ${syncedId}`,
            );
            continue;
          }
          resolvedIds.push(localId);
        }
        padWithProfileId.audioFileIds = resolvedIds;

        // Also map audioTrimSettings keys
        if (padWithProfileId.audioTrimSettings) {
          const mappedTrim: Record<
            number,
            { trimStart: number; trimEnd: number }
          > = {};
          for (const [oldIdStr, trimValue] of Object.entries(
            padWithProfileId.audioTrimSettings,
          )) {
            const newId = audioIdMap.get(Number(oldIdStr));
            if (newId !== undefined) {
              mappedTrim[newId] = trimValue;
            }
          }
          padWithProfileId.audioTrimSettings = mappedTrim;
        }
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
      const pageWithProfileId = {
        ...page,
        profileId: profileId,
        createdAt: toDate(page.createdAt),
        updatedAt: toDate(page.updatedAt),
      };
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

    return warnings;
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
