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
 * - The condition is provable, not inferred. It is the `borrowed-drive-folder`
 *   defect: a server-synced profile whose owner is *known* to be someone else,
 *   still holding Drive ids. "Known" excludes the profiles written before
 *   `serverRole` existed, where a collaborator is indistinguishable from an
 *   owner and clearing would make the next sync build a new folder and
 *   re-upload every sound into it.
 * - Clearing them loses nothing. Audio reaches a collaborator through
 *   `downloadMissingAudioFiles`, which resolves each sound by its own
 *   `driveFileId` from the profile blob and never looks at the folder. And
 *   `ownsDriveFolder` already refuses to publish into a known collaborator's
 *   folder, so the ids were doing nothing but sitting there.
 *
 * The condition used to be written out here as well, and the two spellings had
 * drifted. This one demanded a `serverShareToken`; `syncState`'s reads
 * `ownership`, which prefers the server's `serverRole` and only falls back to
 * a token — the fallback exists precisely because, as the comment there says,
 * a token "misses an email-invited editor, who has no token". So an editor
 * invited by email, or anyone the server marked read-only, was shown the
 * banner for a defect that `SyncDefectBanner` states is cleared on load, has
 * no fix button, and was never going to clear. One question, one rule.
 */

import { getAllProfiles, updateProfile, type Profile } from "@/lib/db";
import { getSyncState } from "@/lib/syncState";

/**
 * Set once the sweep has run, so it does not walk every profile on every load.
 * Versioned: a future repair can bump the suffix rather than reusing this key.
 */
export const BORROWED_LINK_SWEEP_KEY = "impamp.reconciledBorrowedDriveLinks.v1";

/**
 * Drive ids that demonstrably belong to whoever shared this profile.
 *
 * The same rule the banner reads, rather than a second spelling of it: an
 * owner who opened their own share link keeps their folder, and a profile too
 * old to name a role is left for the user.
 */
export function hasBorrowedDriveLink(profile: Profile): boolean {
  return getSyncState(profile).defects.includes("borrowed-drive-folder");
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
