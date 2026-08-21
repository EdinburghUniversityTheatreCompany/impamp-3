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

import {
  getAudioFileIdsForProfile,
  getProfile,
  hasProfileChangedSince,
  updateProfile,
  type Profile,
} from "@/lib/db";
import {
  describesSameSyncState,
  detectProfileConflicts,
  normaliseIncomingSyncData,
  type ConflictOrigin,
} from "@/lib/syncUtils";
import {
  getSyncState,
  isReadOnlyForSync,
  ownsDriveFolder,
} from "@/lib/syncState";
import {
  backfillDriveFileIdsFromRemote,
  getLocalProfileSyncData,
  updateLocalData,
} from "@/lib/googleDrive/dataAccess";
import { updateSyncTimestamp } from "@/lib/googleDrive/utils";
import {
  downloadMissingAudioFiles,
  uploadMissingAudioFiles,
} from "@/lib/googleDrive/sync";
import {
  downloadProfileAudio,
  markHostedAudio,
  uploadProfileAudio,
} from "@/lib/serverAudio/transfer";
import type { SyncConflictData, TokenInfo } from "@/lib/googleDrive/types";
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
  type ServerRole,
} from "./types";
import { coalesceSyncRun, createSyncRunRegistry } from "@/lib/syncReplay";

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
  /**
   * The three versions a conflict is between, so a human can settle it.
   *
   * Server sync used to report only the *list* of conflicts and an error
   * string. The list had no consumer and the error was a red line under the
   * profile with nothing to click, so a server conflict simply stopped the
   * profile converging until someone changed something by hand.
   */
  onConflictDataAvailable?: (data: SyncConflictData | null) => void;
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
 * notification, the edit debounce and a manual sync can all fire at once — and
 * a caller that joins one still hears how it went.
 */
const runs = createSyncRunRegistry<ServerSyncResult, ServerSyncCallbacks>();

export function syncServerProfile(
  profileId: number,
  callbacks: ServerSyncCallbacks,
  drive: DriveAccess = NO_DRIVE,
): Promise<ServerSyncResult> {
  return coalesceSyncRun(runs, profileId, callbacks, (fanOut) =>
    performServerSync(profileId, fanOut, drive),
  );
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

    const warnings: string[] = [];
    const { audio, audioIsExplicit } = getSyncState(profile);

    // Optional, gated server-hosted audio. Silently does nothing when the
    // deployment hosts none or the account is not approved, which is the
    // default — see docs/wasabi-audio.md.
    //
    // A profile that predates `audioLocation` has no stored answer, and one
    // cannot be inferred: hosted audio leaves no local trace. Those keep the
    // old behaviour of uploading whenever the account is approved, because
    // reading the inferred "not hosted" as an instruction would silently stop
    // uploads for everyone already relying on them.
    const hostedHashes = new Set<string>();
    const mayHost = audioIsExplicit ? audio === "server" : true;
    if (!isReadOnlyForSync(profile) && mayHost) {
      const upload = await uploadProfileAudio([
        ...(await getAudioFileIdsForProfile(profileId)),
      ]);
      upload.hosted.forEach((hash) => hostedHashes.add(hash));
      warnings.push(...upload.warnings);
    }

    if (!profile.serverProfileId) {
      // Nothing to pull, so there is nothing to learn from first.
      await publishAudioToDrive(profile, drive);
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

/**
 * Puts this profile's audio in Drive, for the profiles whose audio lives there.
 *
 * Audio must reach its host before the blob that references it does, otherwise
 * a collaborator pulls pads pointing at files that aren't there yet.
 *
 * "Only the owner" has to be checked, not assumed. A collaborator's
 * `googleDriveFolderId` was copied out of the owner's blob, so an editor
 * reaching this line would write into someone else's Drive folder — and
 * `uploadMissingAudioFiles` treats per-file failures as non-fatal, so it failed
 * silently and the sounds never arrived. Ownership is "unknown" for profiles
 * written before `serverRole` existed; those keep the old behaviour, because
 * assuming they are collaborators would stop real owners publishing at all.
 *
 * Call this *after* the remote blob has been read and backfilled, never before:
 * the decision about what still needs uploading is made purely on
 * `driveFileIds[profileId]`, so a device that holds the audio without a
 * per-profile Drive id — after an `.iaz` restore, a duplicated profile, or a
 * profile switched from local to server sync — would otherwise upload the whole
 * library again and leave two Drive files per sound.
 */
async function publishAudioToDrive(
  profile: Profile,
  drive: DriveAccess,
): Promise<void> {
  const { audio } = getSyncState(profile);
  if (
    audio !== "googleDrive" ||
    !ownsDriveFolder(profile) ||
    !drive.tokenInfo ||
    !profile.googleDriveFolderId
  ) {
    return;
  }
  await uploadMissingAudioFiles(
    profile.id!,
    drive.tokenInfo,
    drive.onTokenRefresh,
    profile.googleDriveFolderId,
  );
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

  const fetched = await fetchServerProfile(serverId, {
    shareToken,
    knownVersion: profile.serverVersion,
    // What we currently believe our access to be. A profile that predates
    // `serverRole` sends nothing and gets the full body, which is what fills
    // it in.
    knownAccess: profile.serverRole,
  });
  // Normalised once here, so the merge, the conflict modal's data, and
  // `describesSameSyncState`'s diff summary below all see the same blob —
  // never the raw one a legacy client at rest may still be holding. The
  // second assignment further down (a lost push race) gets the same
  // treatment where it happens.
  let remote = fetched
    ? { ...fetched, data: normaliseIncomingSyncData(fetched.data) }
    : null;

  // What the remote already knows about where the audio lives, adopted before
  // deciding what still needs uploading. The Drive engine has always done this
  // in this order and says why; the server engine uploaded first and never
  // backfilled at all, so it re-uploaded files the remote blob was already
  // naming.
  if (remote?.data.audioFiles?.length) {
    await backfillDriveFileIdsFromRemote(remote.data.audioFiles, profileId);
  }
  await publishAudioToDrive(profile, drive);

  // 304: the server is where we left it. Local edits, if any, still need
  // pushing, so carry on with the version we already know.
  let remoteVersion = remote?.version ?? profile.serverVersion ?? 1;
  // What the server permits, which it restates on every pull.
  let remoteReadOnly = remote ? remote.access === "viewer" : !!profile.readOnly;
  // Our own choice not to contribute, which the server knows nothing about.
  const following = Boolean(profile.followOnly);

  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    // Before the read, not after: everything from here until the write below
    // is a window in which the user can edit a record this merge will never
    // see, and `updateLocalData` needs to know where that window opened.
    const localReadAt = Date.now();
    const raw = await getLocalProfileSyncData(profileId);
    if (!raw) throw new Error("Could not load local profile data.");
    const localData = markHostedAudio(raw, hostedHashes);

    const { requiresManualResolution, conflicts, mergedData } =
      await detectProfileConflicts(localData, remote?.data ?? null);

    // Fetch any audio the merged state references but this device lacks.
    // Applying the merge without it would clear those pads locally — and
    // then push that loss to everyone else.
    //
    // Before the conflict check, not after. A resolution is applied through
    // the same `updateLocalData`, so a conflict that returned early left the
    // user settling it against audio that had never been fetched, and the
    // pads were cleared the moment they chose. The Drive engine has always
    // downloaded first, which is why it never had this hole.
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

    if (requiresManualResolution) {
      onConflictsDetected(conflicts);
      if (remote) {
        callbacks.onConflictDataAvailable?.({
          local: localData,
          // mergedData carries every automatically resolved change; it is the
          // base a resolution builds on, and resolving from local alone would
          // silently drop all of it.
          remote: remote.data,
          merged: mergedData,
          fileId: "",
          origin: {
            kind: "server",
            serverProfileId: serverId,
            version: remoteVersion,
          },
        });
      }
      onStatusChange("conflict");
      onError("Sync conflicts detected. Manual resolution required.");
      return { status: "conflict", conflicts };
    }

    // Marking audio as hosted has to reach the blob, and it touches no pad, so
    // `hasProfileChangedSince` cannot see it. Read from `raw`, which is what
    // this device believed before `markHostedAudio` had its say.
    const hostedAudioIsNew = raw.audioFiles.some(
      (file) => file.hash && hostedHashes.has(file.hash) && !file.serverHosted,
    );

    // Nothing the other side does not already know.
    //
    // Every push bumps the server's version, every bump publishes an SSE
    // change, and every change triggers a sync — so a sync that pushed
    // unconditionally closed a loop: two tabs with the same profile open
    // pushed to each other at SSE latency for as long as both stayed open,
    // each round a full GET, a full local read, a merge and a full PUT. Two
    // tabs of one browser were enough, because the origin id that suppresses
    // an echo is per tab.
    //
    // The comparison has to be the honest one, not `JSON.stringify` of the
    // two blobs: the ids in them are per-device, so literally identical
    // boards never compare equal. `describesSameSyncState` is that comparison.
    // On a 304 there is no remote blob to compare against, and the question
    // becomes "has anything changed here since we last synced".
    const nothingToSend =
      !hostedAudioIsNew &&
      (remote
        ? describesSameSyncState(mergedData, remote.data)
        : !(await hasProfileChangedSince(
            profileId,
            localData._lastSyncTimestamp ?? 0,
          )));

    mergedData._lastSyncTimestamp = Date.now();

    // Three separate reasons not to push, and any of them holds it back: the
    // server refusing writes, us choosing not to make any, and having nothing
    // to say. Gating on the first alone let a follower keep writing to a
    // profile it could write to — which is the one thing following promises
    // not to do.
    if (remoteReadOnly || following || nothingToSend) {
      warnings.push(
        ...(await updateLocalData(profileId, mergedData, localReadAt)),
      );
      await updateProfile(profileId, {
        serverVersion: remoteVersion,
        ...accessFields(remote),
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

      warnings.push(
        ...(await updateLocalData(profileId, mergedData, localReadAt)),
      );
      await updateProfile(profileId, {
        serverVersion: pushed.version,
        ...accessFields(remote),
      });
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
        data: normaliseIncomingSyncData(error.currentData),
      };
      remoteReadOnly = remote.access === "viewer";
    }
  }

  const message = `Could not save profile: it kept changing on the server. Will retry on the next sync.`;
  onError(message);
  onStatusChange("error");
  return { status: "error", error: message };
}

/**
 * The access the server just reported, written back every sync.
 *
 * Recorded rather than assumed, because nothing else refreshes it: a device
 * that once had viewer access kept `readOnly: true` forever, and now that
 * editing is gated on it, being promoted to editor would never take effect.
 */
function accessFields(remote: { access: ServerRole } | null): Partial<Profile> {
  if (!remote) return {};
  return { readOnly: remote.access === "viewer", serverRole: remote.access };
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

/**
 * Settle a server-sync conflict with the version the user chose.
 *
 * Pushed at the version the conflict was detected against, so a third writer
 * landing in between is refused rather than silently overwritten — the same
 * optimistic-concurrency rule every other write obeys. A refusal here is not
 * an error to hide: the next sync re-merges against the newer state and asks
 * again if it still cannot decide.
 */
export async function applyServerConflictResolution(
  profileId: number,
  resolvedData: ProfileSyncData,
  origin: Extract<ConflictOrigin, { kind: "server" }>,
): Promise<ServerSyncResult> {
  try {
    // The token is how a link-share editor is allowed to write at all.
    // Without it their resolution came back "no longer available on the
    // server", and the conflict never cleared.
    const profile = await getProfile(profileId);
    const pushed = await pushServerProfile(
      origin.serverProfileId,
      resolvedData.profile.name,
      resolvedData,
      origin.version,
      profile?.serverShareToken ?? null,
    );
    // These say which sounds a pad could not be given. Dropping them meant a
    // resolution could quietly land with pads it had emptied.
    const warnings = await updateLocalData(profileId, resolvedData);
    await updateProfile(profileId, { serverVersion: pushed.version });
    updateSyncTimestamp(profileId);
    return {
      status: "success",
      version: pushed.version,
      data: resolvedData,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    if (error instanceof VersionConflictError) {
      return {
        status: "error",
        error:
          "Someone else saved while you were choosing. Your choices were not applied — sync again to see the newer version.",
      };
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Could not resolve.",
    };
  }
}
