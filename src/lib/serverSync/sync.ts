/**
 * Server-backed profile synchronisation.
 *
 * The merge is the *same* code the Drive sync uses (`detectProfileConflicts`)
 * — only the remote changes. What server sync adds is optimistic concurrency:
 * every push carries the version it was based on, and a rejected push comes
 * back with the winning state, which we merge into and retry. Two people
 * editing in the same window therefore converge instead of clobbering.
 *
 * Audio is untouched by all this. It lives in Google Drive exactly as before;
 * the blob carries content hashes and Drive file IDs, and collaborators fetch
 * the bytes from Drive (or, signed out, through the public proxy).
 */

import { getProfile, updateProfile } from "@/lib/db";
import { detectProfileConflicts } from "@/lib/syncUtils";
import {
  getLocalProfileSyncData,
  updateLocalData,
} from "@/lib/googleDrive/dataAccess";
import {
  downloadMissingAudioFiles,
  uploadMissingAudioFiles,
} from "@/lib/googleDrive/sync";
import type { TokenInfo } from "@/lib/googleDrive/types";
import {
  createServerProfile,
  fetchServerProfile,
  pushServerProfile,
} from "./api";
import {
  VersionConflictError,
  type ItemConflict,
  type ProfileSyncData,
  type ServerSyncResult,
  type ServerSyncStatus,
} from "./types";

export interface ServerSyncCallbacks {
  onStatusChange: (status: ServerSyncStatus) => void;
  onError: (error: string | null) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
}

/**
 * How many times a push may be re-merged after losing a race before we give
 * up and let the next scheduled sync try again. Three is generous: each retry
 * means another writer landed in the milliseconds since we last pulled.
 */
const MAX_PUSH_ATTEMPTS = 3;

/** Drive access, when the user has it. Null means "audio via public proxy only". */
export interface DriveAccess {
  tokenInfo: TokenInfo | null;
  onTokenRefresh: (token: TokenInfo) => void;
}

const NO_DRIVE: DriveAccess = { tokenInfo: null, onTokenRefresh: () => {} };

/**
 * Concurrent syncs for one profile share a single run — sign-in, the SSE
 * notification, the edit debounce and a manual sync can all fire at once.
 */
const inFlight = new Map<number, Promise<ServerSyncResult>>();

export function syncServerProfile(
  profileId: number,
  callbacks: ServerSyncCallbacks,
  drive: DriveAccess = NO_DRIVE,
): Promise<ServerSyncResult> {
  const running = inFlight.get(profileId);
  if (running) return running;

  const run = performServerSync(profileId, callbacks, drive).finally(() => {
    inFlight.delete(profileId);
  });
  inFlight.set(profileId, run);
  return run;
}

async function performServerSync(
  profileId: number,
  callbacks: ServerSyncCallbacks,
  drive: DriveAccess,
): Promise<ServerSyncResult> {
  const { onStatusChange, onError, onConflictsDetected } = callbacks;

  onStatusChange("syncing");
  onError(null);
  onConflictsDetected([]);

  try {
    const profile = await getProfile(profileId);
    if (!profile) throw new Error(`Profile ${profileId} not found locally.`);

    if (profile.syncType !== "server") {
      onStatusChange("idle");
      return { status: "skipped", reason: "Not a server-synced profile" };
    }

    if (profile.syncPausedUntil && Date.now() < profile.syncPausedUntil) {
      const resumeTime = new Date(profile.syncPausedUntil).toLocaleString();
      onStatusChange("idle");
      onError(`Sync paused until ${resumeTime}`);
      return { status: "skipped", reason: `Paused until ${resumeTime}` };
    }

    // Audio must reach Drive before the blob that references it does,
    // otherwise a collaborator pulls pads pointing at files that aren't there
    // yet. Only the owner uploads, and only when Drive is actually connected.
    const warnings: string[] = [];
    if (!profile.readOnly && drive.tokenInfo && profile.googleDriveFolderId) {
      await uploadMissingAudioFiles(
        profileId,
        drive.tokenInfo,
        drive.onTokenRefresh,
        profile.googleDriveFolderId,
      );
    }

    if (!profile.serverProfileId) {
      return await adoptProfile(profileId, callbacks);
    }

    return await pullMergePush(profileId, callbacks, drive, warnings);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Server sync failed.";
    console.error(`Server sync failed for profile ${profileId}:`, error);
    onError(message);
    onStatusChange("error");
    return { status: "error", error: message };
  }
}

/** First sync of a local profile: create it on the server as-is. */
async function adoptProfile(
  profileId: number,
  callbacks: ServerSyncCallbacks,
): Promise<ServerSyncResult> {
  const localData = await getLocalProfileSyncData(profileId);
  if (!localData) throw new Error("Could not load local profile data.");

  localData._lastSyncTimestamp = Date.now();
  const created = await createServerProfile(localData.profile.name, localData);

  await updateProfile(profileId, {
    serverProfileId: created.id,
    serverVersion: created.version,
  });

  callbacks.onStatusChange("success");
  console.log(
    `Profile ${profileId} adopted by the server as ${created.id} (v${created.version}).`,
  );
  return { status: "success", version: created.version, data: localData };
}

async function pullMergePush(
  profileId: number,
  callbacks: ServerSyncCallbacks,
  drive: DriveAccess,
  warnings: string[],
): Promise<ServerSyncResult> {
  const { onStatusChange, onError, onConflictsDetected } = callbacks;
  const profile = (await getProfile(profileId))!;
  const serverId = profile.serverProfileId!;
  const shareToken = profile.serverShareToken ?? null;

  let remote = await fetchServerProfile(serverId, {
    shareToken,
    knownVersion: profile.serverVersion,
  });

  // 304: the server is where we left it. Local edits, if any, still need
  // pushing, so carry on with the version we already know.
  let remoteVersion = remote?.version ?? profile.serverVersion ?? 1;
  let readOnly = remote ? remote.access === "viewer" : !!profile.readOnly;

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const localData = await getLocalProfileSyncData(profileId);
    if (!localData) throw new Error("Could not load local profile data.");

    const { requiresManualResolution, conflicts, mergedData } =
      await detectProfileConflicts(localData, remote?.data ?? null);

    if (requiresManualResolution) {
      onConflictsDetected(conflicts);
      onStatusChange("conflict");
      onError("Sync conflicts detected. Manual resolution required.");
      return { status: "conflict", conflicts };
    }

    // Fetch any audio the merged state references but this device lacks.
    // Applying the merge without it would clear those pads locally — and
    // then push that loss to everyone else.
    if (remote?.data.audioFiles?.length) {
      const downloads = await downloadMissingAudioFiles(
        remote.data.audioFiles,
        profileId,
        drive.tokenInfo,
        drive.onTokenRefresh,
      );
      warnings.push(...downloads.warnings);
      if (downloads.retryable.length > 0) {
        throw new Error(
          `Could not download ${downloads.retryable.length} audio file(s) — sync postponed: ${downloads.retryable.join("; ")}`,
        );
      }
    }

    mergedData._lastSyncTimestamp = Date.now();

    if (readOnly) {
      warnings.push(...(await updateLocalData(profileId, mergedData)));
      await updateProfile(profileId, {
        serverVersion: remoteVersion,
        readOnly: true,
      });
      return finish(callbacks, remoteVersion, mergedData, warnings);
    }

    try {
      const pushed = await pushServerProfile(
        serverId,
        mergedData.profile.name,
        mergedData,
        remoteVersion,
        shareToken,
      );

      warnings.push(...(await updateLocalData(profileId, mergedData)));
      await updateProfile(profileId, { serverVersion: pushed.version });
      return finish(callbacks, pushed.version, mergedData, warnings);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;

      // Someone landed a write between our pull and our push. Re-merge
      // against what they wrote and try again.
      console.log(
        `Push for profile ${profileId} lost a race (attempt ${attempt}/${MAX_PUSH_ATTEMPTS}) — re-merging against v${error.currentVersion}.`,
      );
      remoteVersion = error.currentVersion;
      remote = {
        id: serverId,
        name: error.currentName,
        version: error.currentVersion,
        updatedAt: Date.now(),
        access: remote?.access ?? "editor",
        data: error.currentData,
      };
      readOnly = remote.access === "viewer";
    }
  }

  const message = `Could not save profile: it kept changing on the server. Will retry on the next sync.`;
  onError(message);
  onStatusChange("error");
  return { status: "error", error: message };
}

function finish(
  callbacks: ServerSyncCallbacks,
  version: number,
  data: ProfileSyncData,
  warnings: string[],
): ServerSyncResult {
  callbacks.onStatusChange("success");
  if (warnings.length > 0) {
    console.warn("Server sync completed with warnings:", warnings);
    callbacks.onError(warnings.join("\n"));
  }
  return {
    status: "success",
    version,
    data,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
