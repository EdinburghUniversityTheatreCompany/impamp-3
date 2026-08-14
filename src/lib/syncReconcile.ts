/**
 * A one-off repair for profiles that already carry someone else's Drive ids.
 *
 * Opening a server share link used to copy the *owner's* `googleDriveFileId`
 * and `googleDriveFolderId` into the recipient's new profile. The import no
 * longer does that, but profiles created before the fix still hold them, and
 * they are not inert: server sync reads `googleDriveFolderId` and tries to
 * upload audio into it, which for a collaborator means writing into a folder
 * they do not own. Those failures are swallowed per file, so it fails quietly.
 *
 * This is the **only** automatic writer in the sync-state work. Everything
 * else a profile can get wrong is surfaced to the user with a choice, because
 * guessing a profile's sync target wrong strands a collaborator's edits. This
 * one is safe to do silently for two reasons:
 *
 * - The condition is provable, not inferred. A `serverShareToken` means the
 *   profile arrived through someone else's link, so the Drive ids in it were
 *   never this device's to begin with. An email-invited editor has no token
 *   and is deliberately left alone — they are indistinguishable from an owner
 *   on a profile written before `serverRole` existed.
 * - Clearing them loses nothing. Audio reaches a collaborator through
 *   `downloadMissingAudioFiles`, which resolves each sound by its own
 *   `driveFileId` from the profile blob and never looks at the folder.
 */

import { getAllProfiles, updateProfile, type Profile } from "@/lib/db";

/**
 * Set once the sweep has run, so it does not walk every profile on every load.
 * Versioned: a future repair can bump the suffix rather than reusing this key.
 */
export const BORROWED_LINK_SWEEP_KEY = "impamp.reconciledBorrowedDriveLinks.v1";

/** Drive ids that demonstrably belong to whoever shared this profile. */
export function hasBorrowedDriveLink(profile: Profile): boolean {
  return (
    profile.syncType === "server" &&
    Boolean(profile.serverShareToken) &&
    Boolean(profile.googleDriveFileId || profile.googleDriveFolderId)
  );
}

/**
 * Clear borrowed Drive ids from every affected profile.
 *
 * Returns how many were repaired. Safe to call more than once — the second
 * call finds nothing — but the caller guards it with
 * `BORROWED_LINK_SWEEP_KEY` so it is not a full profile scan on every load.
 */
export async function reconcileBorrowedDriveLinks(): Promise<number> {
  const affected = (await getAllProfiles()).filter(hasBorrowedDriveLink);

  for (const profile of affected) {
    await updateProfile(profile.id!, {
      googleDriveFileId: null,
      googleDriveFolderId: null,
    });
  }

  if (affected.length > 0) {
    console.log(
      `Cleared borrowed Google Drive links from ${affected.length} shared profile(s).`,
    );
  }
  return affected.length;
}
