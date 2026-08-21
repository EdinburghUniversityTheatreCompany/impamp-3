/**
 * Which route to a sound a *recipient* should take.
 *
 * A profile migrated to hosted audio publishes both: its refs keep the Drive
 * ids they were uploaded with and gain `serverHosted`. The importer picks the
 * Drive route whenever a `driveFileId` is present, which is the wrong way
 * round for anyone joining through a share link.
 *
 * The Drive file belongs to the *owner*. A recipient reaches it only if they
 * are signed in to Google with a grant on that file, or the owner made the
 * folder readable by anyone with the link — and a deployment that hosts audio
 * is precisely one where the owner had no reason to do either. When it fails,
 * the sound is skipped and the pad arrives empty; there is nothing to retry
 * later, because the import is a one-off. Meanwhile the bytes are on the
 * server, and the share token the recipient already holds is exactly the
 * credential for them.
 *
 * So a recipient's copy of the blob names the hosted route, and keeps the
 * Drive id to hand as a fallback rather than as the first choice.
 */

import type { ProfileSyncData } from "@/lib/syncUtils";

export interface HostedPreference {
  /** The blob to import: hosted sounds no longer name a Drive file. */
  data: ProfileSyncData;
  /**
   * The owner's Drive id for each hosted sound that had one, so a hosted
   * fetch that fails can still try the route it displaced.
   */
  driveFallbacks: Map<string, string>;
}

/**
 * Rewrite a profile blob so sounds this server hosts are fetched from it.
 *
 * Only refs that are hosted *and* carry a hash are touched: the hash is what
 * the hosted route fetches by, so a ref without one has no hosted route to
 * prefer. Everything else — Drive-only refs, embedded base64, the pads, the
 * banks — is passed through untouched.
 */
export function preferHostedAudio(data: ProfileSyncData): HostedPreference {
  const driveFallbacks = new Map<string, string>();
  const audioFiles = data.audioFiles;
  if (!audioFiles?.length) return { data, driveFallbacks };

  let changed = false;
  const rewritten = audioFiles.map((ref) => {
    if (!ref.serverHosted || !ref.hash || !ref.driveFileId) return ref;
    driveFallbacks.set(ref.hash, ref.driveFileId);
    changed = true;
    const { driveFileId: _displaced, ...withoutDrive } = ref;
    return withoutDrive;
  });

  // A new object only when something moved, so the common case — no hosted
  // audio at all — hands the importer the blob it was given.
  return changed
    ? { data: { ...data, audioFiles: rewritten }, driveFallbacks }
    : { data, driveFallbacks };
}
