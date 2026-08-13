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
}
