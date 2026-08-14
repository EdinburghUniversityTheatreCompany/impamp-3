/**
 * Moving a profile between sync states.
 *
 * Every move is planned here, as data, before anything is written. That is a
 * direct response to how the old code got this wrong: "Sync to Google Drive"
 * wrote `syncType` and a file id and left `serverProfileId` untouched, so the
 * profile stopped syncing to the server while still claiming to live there,
 * and the UI offered no way back. A plan makes the whole write inspectable —
 * and testable — before it happens, and carries the snapshot needed to undo it
 * as one unit.
 *
 * `updateProfile` stamps `_fieldsModified` per key, so a half-applied
 * transition leaves half the bookkeeping pointing at the old backend and half
 * at the new. Callers must apply `fieldUpdates` in a single write and restore
 * `rollbackTo` in a single write on failure.
 */

import type { AudioLocation, Profile } from "@/lib/db";
import { getSyncState, isLegalPair, type SyncTarget } from "@/lib/syncState";

export interface SyncDestination {
  target: SyncTarget;
  audio: AudioLocation;
}

/**
 * Work that has to happen around the write, in the order given.
 *
 * These are named rather than executed because the executor needs React hooks
 * and network access, and this module must stay pure.
 */
export type TransitionEffect =
  /** Create the per-profile Drive folder before anything expects it to exist. */
  | "ensureDriveFolder"
  /** Forget which Drive file each local sound corresponds to. */
  | "clearAudioDriveIds"
  /** Run a Drive sync; it creates the folder and uploads the profile. */
  | "driveSyncNow"
  /** Run a server sync; with no `serverProfileId` this adopts the profile. */
  | "serverSyncNow"
  /** Ask whether to delete the now-unused copy on the server. */
  | "offerDeleteServerProfile";

export interface TransitionPlan {
  ok: boolean;
  /** Why the move was refused. Only set when `ok` is false. */
  reason?: string;
  /** The complete write, to be applied as one `updateProfile` call. */
  fieldUpdates: Partial<Profile>;
  /** The same keys, with their current values, for a one-call undo. */
  rollbackTo: Partial<Profile>;
  effects: TransitionEffect[];
  /** Consequences worth showing the user before they confirm. */
  warnings: string[];
}

const SERVER_FIELDS = [
  "serverProfileId",
  "serverVersion",
  "serverShareToken",
  "serverRole",
] as const;

function refuse(reason: string): TransitionPlan {
  return {
    ok: false,
    reason,
    fieldUpdates: {},
    rollbackTo: {},
    effects: [],
    warnings: [],
  };
}

export function planTransition(
  profile: Profile,
  dest: SyncDestination,
): TransitionPlan {
  if (!isLegalPair(dest.target, dest.audio)) {
    return refuse(
      dest.target === "local"
        ? "A profile that syncs nowhere has no one to share its sounds with."
        : "Google Drive profiles cannot use server-hosted sounds: collaborators would have no way to ask the server for them.",
    );
  }

  const state = getSyncState(profile);

  // Publishing someone else's profile under our own account would fork it
  // silently and, worse, write into their Drive folder. Disconnecting is the
  // one thing a collaborator may always do.
  if (state.ownership === "collaborator" && dest.target !== "local") {
    return refuse(
      "This profile is shared with you. Make your own copy before changing where it syncs.",
    );
  }

  // Already there, and healthy. Compared against the *stored* audio rather
  // than the resolved one, so a profile predating `audioLocation` still gets
  // its intent written down instead of staying inferred forever.
  if (
    profile.syncType === dest.target &&
    profile.audioLocation === dest.audio &&
    state.defects.length === 0
  ) {
    return {
      ok: true,
      fieldUpdates: {},
      rollbackTo: {},
      effects: [],
      warnings: [],
    };
  }

  const staysOnDrive =
    profile.syncType === "googleDrive" && dest.target === "googleDrive";
  const staysOnServer =
    profile.syncType === "server" && dest.target === "server";
  const keepsDriveAudio = dest.audio === "googleDrive";

  const fieldUpdates: Partial<Profile> = {};
  const effects: TransitionEffect[] = [];
  const warnings: string[] = [];

  /** Only write a null over something that is actually set. */
  const clear = (field: keyof Profile) => {
    if (profile[field] != null) {
      (fieldUpdates as Record<string, unknown>)[field] = null;
    }
  };

  if (profile.syncType !== dest.target) fieldUpdates.syncType = dest.target;
  if (profile.audioLocation !== dest.audio) {
    fieldUpdates.audioLocation = dest.audio;
  }

  // `googleDriveFileId` is the profile JSON — it belongs to the sync axis.
  // `googleDriveFolderId` is where the sounds live — it belongs to the audio
  // axis. Keeping them apart is what lets a server-synced profile go on
  // publishing its audio to Drive.
  if (!staysOnDrive) clear("googleDriveFileId");

  // Only "sounds stay on this device" really severs the Drive audio link.
  // Switching to hosted audio deliberately leaves the folder and the per-file
  // Drive ids in place: the blob stops referencing them (see
  // `getLocalProfileSyncData`), so switching back costs nothing, whereas
  // re-linking would re-upload every sound and leave duplicates in the folder.
  if (dest.audio === "local") {
    clear("googleDriveFolderId");
    if (profile.googleDriveFolderId) effects.push("clearAudioDriveIds");
  }

  if (!staysOnServer) SERVER_FIELDS.forEach(clear);

  // Taking a profile somewhere new makes us its owner there, so a read-only
  // flag inherited from a previous home no longer applies. Written explicitly
  // rather than left absent: an unset `readOnly` is exactly what lets a remote
  // blob decide the answer.
  if (profile.syncType !== dest.target) fieldUpdates.readOnly = false;

  // Nothing on the server path creates the folder, unlike a Drive sync.
  if (
    dest.target === "server" &&
    keepsDriveAudio &&
    !profile.googleDriveFolderId
  ) {
    effects.push("ensureDriveFolder");
  }

  if (dest.target === "googleDrive") effects.push("driveSyncNow");
  if (dest.target === "server") effects.push("serverSyncNow");

  if (
    !staysOnServer &&
    profile.serverProfileId &&
    state.ownership === "owner"
  ) {
    effects.push("offerDeleteServerProfile");
  }

  // --- consequences worth stating before the user commits ---

  if (profile.syncType === "googleDrive" && dest.target !== "googleDrive") {
    warnings.push(
      "The profile file in Google Drive stops updating. Delete it there if you no longer want it.",
    );
  }
  if (profile.syncType === "server" && dest.target !== "server") {
    warnings.push(
      "Your copy on the ImpAmp server is no longer updated, and collaborators stop receiving your changes.",
    );
  }
  if (state.audio === "server" && dest.audio === "googleDrive") {
    warnings.push(
      "Sounds currently hosted on the server will be uploaded to Google Drive.",
    );
  }
  if (dest.audio === "local" && dest.target !== "local") {
    warnings.push(
      "Collaborators will get this profile with silent pads: nothing publishes the sounds.",
    );
  }
  if (dest.target === "local" && profile.syncType !== "local") {
    warnings.push(
      "This device keeps every sound. The copies in Drive and on the server are left alone.",
    );
  }

  // Restoring `undefined` would leave the new value in place, so an absent
  // prior value rolls back to the falsy member of its own type instead.
  const rollbackTo: Partial<Profile> = {};
  for (const key of Object.keys(fieldUpdates)) {
    const previous = (profile as unknown as Record<string, unknown>)[key];
    (rollbackTo as Record<string, unknown>)[key] =
      previous ?? (key === "readOnly" ? false : null);
  }

  return { ok: true, fieldUpdates, rollbackTo, effects, warnings };
}
