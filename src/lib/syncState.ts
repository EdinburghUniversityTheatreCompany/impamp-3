/**
 * How a profile syncs, as two independent questions.
 *
 * The app has always had two axes here and only one field to say them with.
 * `syncType` answers "where does the profile itself sync?"; where its *audio*
 * lives is separate, and a server-synced profile publishing its sounds through
 * a Google Drive folder is a real, working combination (see
 * `serverSync/sync.ts`, which uploads to Drive and downloads from both
 * backends on the same sync). Nothing surfaced that, so the combination was
 * reached by accident rather than chosen.
 *
 * This module is the single place that reads those fields and says what state
 * a profile is actually in — including the states that shouldn't exist, which
 * previous versions of the UI could produce and offered no way out of.
 *
 * It is deliberately **pure and synchronous**: it runs in render for every
 * profile card and every row of the profile switcher. Capability questions
 * ("may this account host audio?") are async and belong in the hook layer, not
 * here.
 */

import type { AudioLocation, Profile, SyncType } from "@/lib/db";

/** Where the profile itself syncs. Mirrors `SyncType` by design. */
export type SyncTarget = SyncType;

/**
 * Matches `ServerRole` in `serverSync/types`, derived from `Profile` rather
 * than imported so this module stays free of the server-sync layer.
 */
export type ProfileRole = NonNullable<Profile["serverRole"]>;

/**
 * Who we are to this profile's remote copy.
 *
 * `"unknown"` is not a failure — it is every server profile written before
 * `serverRole` existed. Callers must fall back to their previous behaviour
 * for it: guessing `"owner"` re-opens cross-account writes into someone
 * else's Drive folder, and guessing `"collaborator"` stops a real owner
 * uploading at all.
 */
export type Ownership = "owner" | "collaborator" | "unknown";

/**
 * A state a profile should never be in. Each one was reachable through the
 * old UI, and each needs a decision from the user rather than a guess — the
 * wrong guess about a sync target strands a collaborator's edits.
 */
export type SyncDefect =
  /** Says it syncs to Drive, but has no file there: a half-finished unlink. */
  | "drive-linked-but-no-file"
  /** Syncs to Drive, but still carries server bookkeeping. */
  | "stale-server-link"
  /** Syncs nowhere, but still carries Drive bookkeeping. */
  | "stale-drive-link"
  /** Says it syncs to the server, but never got an id from it. */
  | "server-awaiting-first-sync"
  /** A collaborator holding the owner's Drive ids — writes there fail silently. */
  | "borrowed-drive-folder"
  /** Publishes audio to Drive, but has no folder to publish it into. */
  | "audio-drive-without-folder"
  /** Syncs somewhere, but publishes its sounds nowhere. */
  | "audio-reaches-nobody";

export interface SyncState {
  target: SyncTarget;
  audio: AudioLocation;
  /** False when `audio` was inferred because the profile predates the field. */
  audioIsExplicit: boolean;
  ownership: Ownership;
  /**
   * Nothing local will be pushed — because the remote refuses writes, or
   * because you chose to follow rather than contribute.
   */
  readOnly: boolean;
  /** Your own choice to follow rather than contribute. */
  following: boolean;
  /**
   * Whether this profile may be changed at all.
   *
   * A profile that cannot push is not merely private to edit: the next sync
   * applies the merged remote state over your changes, so they are destroyed
   * rather than kept to yourself. Blocking the edit is the honest behaviour.
   */
  canEdit: boolean;
  /** Whether dropping the follow would leave a profile you can actually write. */
  canUnfollow: boolean;
  /** True when this is someone else's profile that we can only read. */
  isViewerOfSomeoneElses: boolean;
  paused: boolean;
  pausedUntil: number | null;
  /** True when a sync engine has something to act on: the backend knows this profile. */
  isLinked: boolean;
  defects: SyncDefect[];
}

/**
 * Whether a target/audio pair is coherent.
 *
 * Two are not. A profile that syncs nowhere has no one to publish audio *to*,
 * and a Drive profile cannot use hosted audio because its blob carries no
 * `serverProfileId` — a collaborator would have no route to ask the server
 * for the bytes.
 */
export function isLegalPair(target: SyncTarget, audio: AudioLocation): boolean {
  if (target === "local") return audio === "local";
  if (target === "googleDrive") return audio !== "server";
  return true;
}

/**
 * Whether a pair is worth *offering*, as opposed to merely describing.
 *
 * A synced profile whose sounds stay on this device is a state profiles land
 * in — a sync that ran before the sounds had anywhere to go leaves one — so it
 * has to be representable. It is not something to offer as a choice: it syncs
 * a soundboard whose pads are silent on every other device including your own.
 * It appears as a defect with a way out instead.
 */
export function isChoosablePair(
  target: SyncTarget,
  audio: AudioLocation,
): boolean {
  if (!isLegalPair(target, audio)) return false;
  return target === "local" || audio !== "local";
}

/**
 * What a profile written before `audioLocation` existed must have meant.
 *
 * The last rule is the interesting one: a server profile with no Drive folder
 * genuinely publishes no audio unless hosting happens to be switched on, so
 * "this device only" is the honest reading — and saying so out loud is itself
 * one of the things that was missing.
 */
function inferAudioLocation(
  profile: Profile,
  target: SyncTarget,
): AudioLocation {
  if (target === "local") return "local";
  if (profile.googleDriveFolderId) return "googleDrive";
  // The folder is created by the first Drive sync, so its absence on a Drive
  // profile is not evidence that the audio lives somewhere else.
  if (target === "googleDrive") return "googleDrive";
  return "local";
}

function resolveOwnership(profile: Profile, target: SyncTarget): Ownership {
  if (target === "local") return "owner";
  // Drive reconciles `readOnly` from the folder's real capabilities on every
  // sync, so it is a reliable answer there.
  if (target === "googleDrive") {
    return profile.readOnly ? "collaborator" : "owner";
  }
  if (profile.serverRole) {
    return profile.serverRole === "owner" ? "owner" : "collaborator";
  }
  // A share token means the profile arrived through someone else's link. It
  // misses an email-invited editor, who has no token — which is exactly why
  // `serverRole` is preferred above.
  if (profile.serverShareToken) return "collaborator";
  if (profile.readOnly) return "collaborator";
  return "unknown";
}

function detectDefects(
  profile: Profile,
  target: SyncTarget,
  audio: AudioLocation,
  ownership: Ownership,
  isLinked: boolean,
): SyncDefect[] {
  const defects: SyncDefect[] = [];
  const hasDriveIds = Boolean(
    profile.googleDriveFileId || profile.googleDriveFolderId,
  );

  if (target === "googleDrive" && !profile.googleDriveFileId) {
    defects.push("drive-linked-but-no-file");
  }
  if (target === "googleDrive" && profile.serverProfileId) {
    defects.push("stale-server-link");
  }
  if (target === "local" && hasDriveIds) {
    defects.push("stale-drive-link");
  }
  if (target === "server" && !profile.serverProfileId) {
    defects.push("server-awaiting-first-sync");
  }
  if (target === "server" && ownership === "collaborator" && hasDriveIds) {
    defects.push("borrowed-drive-folder");
  }
  if (target !== "local" && audio === "local" && isLinked) {
    defects.push("audio-reaches-nobody");
  }
  if (
    target === "server" &&
    audio === "googleDrive" &&
    !profile.googleDriveFolderId &&
    !profile.readOnly &&
    // Before the first sync, "you haven't synced yet" is the useful message;
    // the missing folder is downstream of it and repeating it is noise.
    isLinked
  ) {
    defects.push("audio-drive-without-folder");
  }

  return defects;
}

/**
 * Whether this device will push changes for a profile.
 *
 * The sync paths used to read `profile.readOnly` directly, which is only what
 * the *remote* permits. Following is a separate decision and has to be
 * honoured just as firmly, so both go through here.
 */
export const isReadOnlyForSync = (profile: Profile): boolean =>
  Boolean(profile.readOnly) || Boolean(profile.followOnly);

/**
 * Whether Drive file ids arriving from a remote may be recorded as *ours*.
 *
 * The blob carries a Drive id for every sound that has one, so anyone with
 * access to the folder can fetch it. Writing those ids onto our own audio
 * records is a different claim: `uploadMissingAudioFiles` reads them as "this
 * sound is already in my folder" and skips it. A server-synced collaborator
 * who adopted the owner's ids and later moved their audio to Drive would
 * upload nothing at all, and their blob would go on pointing into a folder
 * they do not own — the borrowed-Drive-folder failure, one level down where
 * `reconcileBorrowedDriveLinks` cannot see it.
 *
 * Drive-synced profiles are unaffected: the profile file lives in that same
 * folder, so anyone syncing through it can reach and write to it.
 */
export function mayAdoptDriveIds(profile: Profile): boolean {
  const { target, ownership } = getSyncState(profile);
  if (target !== "server") return true;
  return ownership === "owner";
}

export function getSyncState(profile: Profile, now = Date.now()): SyncState {
  const target = profile.syncType;

  const stored = profile.audioLocation;
  const audioIsExplicit = Boolean(stored && isLegalPair(target, stored));
  const audio = audioIsExplicit
    ? (stored as AudioLocation)
    : inferAudioLocation(profile, target);

  const ownership = resolveOwnership(profile, target);
  // What the remote permits, before any choice of ours.
  const remoteReadOnly = Boolean(profile.readOnly);
  const following = Boolean(profile.followOnly);
  const readOnly = remoteReadOnly || following;

  const isLinked =
    target === "googleDrive"
      ? Boolean(profile.googleDriveFileId)
      : target === "server"
        ? Boolean(profile.serverProfileId)
        : false;

  const pausedUntil =
    profile.syncPausedUntil != null && profile.syncPausedUntil > now
      ? profile.syncPausedUntil
      : null;

  return {
    target,
    audio,
    audioIsExplicit,
    ownership,
    readOnly,
    following,
    canEdit: !readOnly,
    // Unfollowing a profile the remote will not accept writes to would promise
    // something it cannot deliver.
    canUnfollow: following && !remoteReadOnly,
    // "Someone else's" is about permission, not preference: following your own
    // board does not make it theirs.
    isViewerOfSomeoneElses: target !== "local" && remoteReadOnly,
    paused: pausedUntil !== null,
    pausedUntil,
    isLinked,
    defects: detectDefects(profile, target, audio, ownership, isLinked),
  };
}

export function syncTargetLabel(target: SyncTarget): string {
  switch (target) {
    case "local":
      return "This device only";
    case "googleDrive":
      return "Google Drive";
    case "server":
      return "ImpAmp server";
  }
}

export function audioLocationLabel(audio: AudioLocation): string {
  switch (audio) {
    case "googleDrive":
      return "Google Drive folder";
    case "server":
      return "ImpAmp server (hosted)";
    case "local":
      return "This device only";
  }
}

/** The short form used inside the status chip, where the label is a clause. */
function audioClause(audio: AudioLocation): string {
  switch (audio) {
    case "googleDrive":
      return "sounds in Drive";
    case "server":
      return "sounds hosted on the server";
    case "local":
      return "sounds stay on this device";
  }
}

/**
 * The one-line summary on a profile card.
 *
 * `relativeTime` is passed in already formatted so this stays pure and has no
 * opinion about clocks — the component supplies "2 minutes ago".
 *
 * Anything needing a decision comes first and replaces the rest: a chip that
 * reads "synced 2 minutes ago" while a defect goes unmentioned is worse than
 * saying nothing.
 */
export function syncChipText(
  state: SyncState,
  relativeTime: string | null,
): string {
  const base = syncTargetLabel(state.target);
  if (state.target === "local") return base;

  if (state.defects.length > 0) return `${base} · needs attention`;
  if (state.isViewerOfSomeoneElses) return `${base} · view only`;
  if (state.paused) return `${base} · paused`;
  // A steady state rather than an alert, but still the thing you most need to
  // know about this profile — it explains why the pads will not edit.
  if (state.following) return `${base} · following`;

  const parts = [base];
  // Under a Drive target, "sounds in Drive" only repeats the target.
  if (state.target !== "googleDrive" || state.audio !== "googleDrive") {
    parts.push(audioClause(state.audio));
  }
  if (relativeTime) parts.push(`synced ${relativeTime}`);

  return parts.join(" · ");
}
