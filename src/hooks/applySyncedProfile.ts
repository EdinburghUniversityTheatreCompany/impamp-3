import { getProfile } from "@/lib/db";
import { useProfileStore } from "@/store/profileStore";

/**
 * Refresh app state after a sync has written to IndexedDB.
 *
 * Both sync backends need this: pads must re-read their configuration, and
 * the store's copy of the profile has to pick up fields the sync itself
 * wrote (readOnly, googleDriveFolderId, serverVersion) — otherwise the UI
 * keeps showing the pre-sync state.
 */
export async function applySyncedProfile(profileId: number): Promise<void> {
  useProfileStore.getState().incrementPadConfigsVersion();

  const updated = await getProfile(profileId);
  if (!updated) return;

  useProfileStore.setState((state) => ({
    profiles: state.profiles.map((p) => (p.id === profileId ? updated : p)),
  }));

  // Sync can deliver audio a collaborator just added — refresh loudness so
  // it doesn't play un-normalised for the rest of the session. Only for the
  // profile currently on screen: `refreshProfileLoudness` calls
  // `loadProfileLoudness`, which *replaces* the whole in-memory loudness
  // cache with the given profile's entries. Running it for a profile that
  // isn't active — e.g. a background periodic sync of a profile the user
  // isn't looking at — would clobber the active profile's resident cache
  // with the wrong profile's data. Fire-and-forget: this reaches into
  // IndexedDB and analysis, and the sync flow this function completes for
  // should not sit through however long a backfill takes.
  if (useProfileStore.getState().activeProfileId === profileId) {
    void import("@/lib/audio/loudness/pipeline")
      .then(({ refreshProfileLoudness }) => refreshProfileLoudness(profileId))
      .catch((error) => {
        console.warn(
          `[Loudness] Post-sync loudness refresh failed for profile ${profileId}:`,
          error,
        );
      });
  }
}
