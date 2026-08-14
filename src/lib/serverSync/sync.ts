/**
 * Server-backed profile synchronisation.
 *
 * The merge is the *same* code the Drive sync uses (`detectProfileConflicts`)
 * — only the remote changes. What server sync adds is optimistic concurrency:
 * every push carries the version it was based on, and a rejected push comes
 * back with the winning state, which we merge into and retry. Two people
 * editing in the same window therefore converge instead of clobbering.
 *
 * Audio lives in Google Drive by default: the blob carries content hashes and
 * Drive file IDs, and collaborators fetch the bytes from Drive (or, signed
 * out, through the public proxy). A deployment that configures Wasabi can also
 * host audio itself for approved accounts, in which case those files are
 * marked `serverHosted` and fetched from the bucket instead — see
 * `src/lib/serverAudio/` and docs/wasabi-audio.md.
 */

import { getAudioFileIdsForProfile, getProfile, updateProfile } from "@/lib/db";
import { detectProfileConflicts } from "@/lib/syncUtils";
import { getSyncState } from "@/lib/syncState";
import {
  getLocalProfileSyncData,
  updateLocalData,
} from "@/lib/googleDrive/dataAccess";
import {
  downloadMissingAudioFiles,
  uploadMissingAudioFiles,
} from "@/lib/googleDrive/sync";
import {
  downloadProfileAudio,
  markHostedAudio,
  uploadProfileAudio,
} from "@/lib/serverAudio/transfer";
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
  /**
   * Things that went wrong without failing the sync — a sound too large to
   * host, say. Separate from `onError` because a sync that succeeded with
   * warnings is not a failed sync, and reporting it through the error channel
   * turned a partial success into a red banner on the profile card.
   */
  onWarnings?: (warnings: string[]) => void;
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

    // Audio must reach its host before the blob that references it does,
    // otherwise a collaborator pulls pads pointing at files that aren't there
    // yet. Only the owner uploads, and only when Drive is actually connected.
    //
    // "Only the owner" has to be checked, not assumed. A collaborator's
    // `googleDriveFolderId` was copied out of the owner's blob, so an editor
    // reaching this line would write into someone else's Drive folder — and
    // `uploadMissingAudioFiles` treats per-file failures as non-fatal, so it
    // failed silently and the sounds never arrived. Ownership is "unknown" for
    // profiles written before `serverRole` existed; those keep the old
    // behaviour, because assuming they are collaborators would stop real
    // owners publishing at all.
    const warnings: string[] = [];
    const ownership = getSyncState(profile).ownership;
    if (
      ownership !== "collaborator" &&
      drive.tokenInfo &&
      profile.googleDriveFolderId
    ) {
      await uploadMissingAudioFiles(
        profileId,
        drive.tokenInfo,
        drive.onTokenRefresh,
        profile.googleDriveFolderId,
      );
    }

    // Optional, gated server-hosted audio. Silently does nothing when the
    // deployment hosts none or the account is not approved, which is the
    // default — see docs/wasabi-audio.md.
    const hostedHashes = new Set<string>();
    if (!profile.readOnly) {
      const upload = await uploadProfileAudio([
        ...(await getAudioFileIdsForProfile(profileId)),
      ]);
      upload.hosted.forEach((hash) => hostedHashes.add(hash));
      warnings.push(...upload.warnings);
    }

    if (!profile.serverProfileId) {
      return await adoptProfile(profileId, callbacks, hostedHashes);
    }

    return await pullMergePush(
      profileId,
      callbacks,
      drive,
      warnings,
      hostedHashes,
    );
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
  hostedHashes: Set<string>,
): Promise<ServerSyncResult> {
  const raw = await getLocalProfileSyncData(profileId);
  if (!raw) throw new Error("Could not load local profile data.");

  const localData = markHostedAudio(raw, hostedHashes);
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
  hostedHashes: Set<string>,
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
    const raw = await getLocalProfileSyncData(profileId);
    if (!raw) throw new Error("Could not load local profile data.");
    const localData = markHostedAudio(raw, hostedHashes);

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
      // Server-hosted files first: they carry `serverHosted` and have no
      // Drive file ID, so the Drive path would skip them entirely.
      const hostedDownloads = await downloadProfileAudio(
        serverId,
        remote.data.audioFiles,
        shareToken,
      );
      warnings.push(...hostedDownloads.warnings);

      const downloads = await downloadMissingAudioFiles(
        remote.data.audioFiles,
        profileId,
        drive.tokenInfo,
        drive.onTokenRefresh,
      );
      warnings.push(...downloads.warnings);

      const retryable = [...hostedDownloads.retryable, ...downloads.retryable];
      if (retryable.length > 0) {
        throw new Error(
          `Could not download ${retryable.length} audio file(s) — sync postponed: ${retryable.join("; ")}`,
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
    callbacks.onWarnings?.(warnings);
  }
  return {
    status: "success",
    version,
    data,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
