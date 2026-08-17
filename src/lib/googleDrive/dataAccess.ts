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
  getAudioFileMetadata,
  ensureAudioFileHash,
  updateAudioFileDriveId,
  collectReferencedAudioFileIds,
  computeBlobHash,
} from "@/lib/db";
import {
  ProfileSyncData,
  reconcileWithStoredRecord,
  resolveSyncedPadAudio,
  type Syncable,
  type SyncedPadConfiguration,
} from "@/lib/syncUtils";
import { base64ToBlob, remapPadSettingsOnImport } from "@/lib/importExport";
import { updateSyncTimestamp } from "./utils";
import { toWireProfile } from "@/lib/profileWire";

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
  //
  // Every route we know about goes in the blob, including a Drive id on a
  // profile whose sounds are meant to be hosted. Withholding it assumes the
  // hosting happened; when it silently does not, the blob names sounds nobody
  // can fetch. `markHostedAudio` marks what is genuinely hosted, and the
  // downloaders dedupe by hash, so carrying both routes costs nothing and
  // leaves Drive as the fallback.
  // One cursor pass rather than a full-record read per file. This was two to
  // three sequential IndexedDB reads *each* — `getAudioFile`, then
  // `ensureAudioFileHash` reading the record again — and the server push calls
  // this inside its retry loop, so a 960-sound board did ~1920 round trips per
  // attempt and up to three times that on a contended push.
  const metadata = await getAudioFileMetadata(audioFileIds);
  const audioFiles = [];

  for (const audioFileId of audioFileIds) {
    const audioFile = metadata.get(audioFileId);
    if (audioFile) {
      audioFiles.push({
        id: audioFileId,
        name: audioFile.name,
        type: audioFile.type,
        // Only files that arrived without one need reading again, and
        // `ensureAudioFileHash` is what computes and stores it.
        hash:
          audioFile.hash ??
          (await ensureAudioFileHash(audioFileId)) ??
          undefined,
        driveFileId: audioFile.driveFileIds?.[profileId],
        // What we already know about where these bytes live. `markHostedAudio`
        // adds whatever this run uploaded on top; without this, a run that
        // could not upload published a blob claiming nothing was hosted.
        serverHosted: audioFile.serverHosted || undefined,
      });
    } else {
      console.warn(
        `Audio file with ID ${audioFileId} referenced but not found`,
      );
    }
  }

  // Say which sound each pad wants in terms that mean the same thing on every
  // device. The id fields stay exactly as they were, so a client running older
  // code reads what it always read; a client that understands hashes never has
  // to work out whose ids these are, which is what the id path got wrong.
  const hashById = new Map<number, string>();
  for (const file of audioFiles) {
    if (file.hash) hashById.set(file.id, file.hash);
  }

  const byHash = <T>(
    settings: Record<number, T> | undefined,
  ): Record<string, T> | undefined => {
    if (!settings) return undefined;
    const result: Record<string, T> = {};
    for (const [id, value] of Object.entries(settings)) {
      const hash = hashById.get(Number(id));
      if (hash) result[hash] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const syncedPads: SyncedPadConfiguration[] = padConfigurations.map((pad) => ({
    ...pad,
    audioFileHashes: pad.audioFileIds?.map((id) => hashById.get(id) ?? null),
    audioTrimSettingsByHash: byHash(pad.audioTrimSettings),
    audioGainSettingsByHash: byHash(pad.audioGainSettings),
  }));

  return {
    _syncFormatVersion: 1,
    _lastSyncTimestamp: lastSyncTimestamp,
    profile: toWireProfile(profile),
    padConfigurations: syncedPads,
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
 * Re-key a hash-keyed settings map onto this device's audio ids.
 *
 * A hash with no local audio is dropped: keeping it would leave a setting
 * attached to nothing, and there is no id to attach it to anyway.
 */
const keyByLocalId = <T>(
  byHash: Record<string, T> | undefined,
  localIdByHash: Map<string, number>,
): Record<number, T> | undefined => {
  if (!byHash) return undefined;
  const result: Record<number, T> = {};
  for (const [hash, value] of Object.entries(byHash)) {
    const localId = localIdByHash.get(hash);
    if (localId !== undefined) result[localId] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
 * @param localReadAt When the merge that produced `data` read its local
 *   snapshot. Anything the user has edited since is strictly newer than this
 *   blob and is kept — see `reconcileWithStoredRecord`. Omit for a write that
 *   is not merge-derived, such as an authoritative pull of a followed profile,
 *   where the remote is meant to win outright.
 * @returns Warnings about references that could not be preserved
 */
export const updateLocalData = async (
  profileId: number,
  data: ProfileSyncData,
  localReadAt?: number,
): Promise<string[]> => {
  if (typeof window === "undefined") return [];

  const db = await getDb();
  const warnings: string[] = [];

  // First, handle audio files import
  const audioIdMap = new Map<number, number>();
  // The same answer keyed by content instead. A hash names one recording
  // everywhere, so a pad that arrives naming hashes needs no translation and
  // cannot be misread whoever wrote it.
  const localIdByHash = new Map<string, number>();
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
      if (hash) localIdByHash.set(hash, newAudioId);
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

  try {
    // 1. Update Profile — preserve local-only fields that must not be overwritten by remote
    const existingLocalProfile = await profileStore.get(profileId);
    const profileWithId = {
      // Against the record as it is now, not as the merge read it. A rename
      // made while this sync was in flight is newer than anything in the blob.
      ...(reconcileWithStoredRecord(
        data.profile as Syncable,
        existingLocalProfile as Syncable | undefined,
        localReadAt,
      ) as typeof data.profile),
      id: profileId,
      name: existingLocalProfile?.name ?? data.profile.name,
      // Where this profile syncs, where its audio lives, and what we may do
      // with it are all this device's own answers — a blob written by another
      // device must never repoint them.
      //
      // Each falls back to a value of its own rather than to `data.profile`.
      // Falling back to the remote is what made these dangerous: `readOnly`
      // and `googleDriveFolderId` are unset on plenty of profiles, so a
      // remote blob could silently mark a profile read-only, or hand this
      // device the *owner's* Drive folder — after which it would try to
      // upload into someone else's folder and fail without saying so.
      syncType: existingLocalProfile?.syncType ?? data.profile.syncType,
      googleDriveFileId: existingLocalProfile?.googleDriveFileId ?? null,
      googleDriveFolderId: existingLocalProfile?.googleDriveFolderId ?? null,
      audioLocation: existingLocalProfile?.audioLocation ?? null,
      serverProfileId: existingLocalProfile?.serverProfileId ?? null,
      serverVersion: existingLocalProfile?.serverVersion ?? null,
      serverShareToken: existingLocalProfile?.serverShareToken ?? null,
      serverRole: existingLocalProfile?.serverRole ?? null,
      readOnly: existingLocalProfile?.readOnly ?? false,
      followOnly: existingLocalProfile?.followOnly ?? false,
      syncPausedUntil: existingLocalProfile?.syncPausedUntil,
      createdAt: toDate(
        existingLocalProfile?.createdAt ?? data.profile.createdAt,
      ),
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

      // Translate the synced audio IDs into this device's IDs.
      // Per pad, not per blob. Gating on the blob having *any* audio entries
      // meant a blob whose list came back empty skipped translation entirely
      // and wrote the sender's raw ids into local pads, which is the "wrong
      // sound" outcome this whole path exists to prevent.
      if (padWithProfileId.audioFileIds?.length) {
        const existing = existingPadMap.get(key);
        const resolved = resolveSyncedPadAudio(
          padWithProfileId.audioFileIds,
          audioIdMap,
          existing?.audioFileIds,
          pad.audioFileHashes,
          localIdByHash,
        );

        for (const syncedId of resolved.unresolved) {
          warnings.push(
            `Pad ${pad.pageIndex}-${pad.padIndex}: dropped unresolved audio reference ${syncedId}`,
          );
        }

        // Both settings maps are keyed by audio file id, so they follow
        // whichever ids the pad ended up with. An id with no local mapping is
        // dropped rather than kept: an untranslated id addresses a different
        // local recording, so a missing setting is the safer outcome.
        if (resolved.keptLocal) {
          warnings.push(
            `Pad ${pad.pageIndex}-${pad.padIndex}: kept the sound already on this device, because the synced copy referenced audio that could not be fetched`,
          );
          // Already keyed by this device's ids, so they must skip the remap —
          // running it would translate them as though they were the sender's,
          // dropping the setting or, on an id collision, moving it to a
          // different sound.
          padWithProfileId.audioTrimSettings = existing?.audioTrimSettings;
          padWithProfileId.audioGainSettings = existing?.audioGainSettings;
        } else if (pad.audioTrimSettingsByHash || pad.audioGainSettingsByHash) {
          padWithProfileId.audioTrimSettings = keyByLocalId(
            pad.audioTrimSettingsByHash,
            localIdByHash,
          );
          padWithProfileId.audioGainSettings = keyByLocalId(
            pad.audioGainSettingsByHash,
            localIdByHash,
          );
        } else {
          padWithProfileId.audioTrimSettings = remapPadSettingsOnImport(
            padWithProfileId.audioTrimSettings,
            audioIdMap,
          );
          padWithProfileId.audioGainSettings = remapPadSettingsOnImport(
            padWithProfileId.audioGainSettings,
            audioIdMap,
          );
        }
        padWithProfileId.audioFileIds = resolved.audioFileIds;
      }

      // The hash-keyed fields are a *wire* representation: synthesised at
      // export, read above to resolve this pad's audio, and re-derived every
      // time the blob is written. Storing them would leave a copy that nothing
      // reads and that can disagree with the ids beside it after a later edit.
      const {
        audioFileHashes: _wireHashes,
        audioTrimSettingsByHash: _wireTrim,
        audioGainSettingsByHash: _wireGain,
        ...padToStore
      } = padWithProfileId;

      // From the map built before the loop, not a fresh index lookup. The get
      // ran once per pad — 960 of them on a full board — inside the write
      // transaction, so it also held the store's locks for longer.
      const existingLocalPad = existingPadMap.get(key);
      // Same reconciliation as the profile above: a pad renamed, or given a
      // different sound, while this sync was in flight is newer than the blob.
      const padToWrite = reconcileWithStoredRecord(
        padToStore as Syncable,
        existingLocalPad as Syncable | undefined,
        localReadAt,
      ) as typeof padToStore;

      if (existingLocalPad?.id) {
        await padStore.put({ ...padToWrite, id: existingLocalPad.id });
      } else {
        const { id: _remoteId, ...padToAdd } = padToWrite;
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
      // From the map built above, for the same reason as the pads.
      const existingLocalPage = existingPageMap.get(page.pageIndex);
      // And the same for a bank renamed mid-sync.
      const pageToWrite = reconcileWithStoredRecord(
        pageWithProfileId as Syncable,
        existingLocalPage as Syncable | undefined,
        localReadAt,
      ) as typeof pageWithProfileId;

      if (existingLocalPage?.id) {
        await pageStore.put({ ...pageToWrite, id: existingLocalPage.id });
      } else {
        const { id: _remoteId, ...pageToAdd } = pageToWrite;
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
