/**
 * What each profile's sync is doing right now.
 *
 * Both sync engines already track this, but each `useGoogleDriveSync` and
 * `useServerSync` call holds its own `useState`. The background syncs run in
 * `ClientSideInitializer`'s instance, so a profile card — holding a different
 * instance — never sees them. That is why the card could only ever report
 * syncs it started itself, and why it needed a `lastSyncInitiatedByThisCard`
 * flag to avoid claiming credit for other cards' work.
 *
 * Putting the status where every reader can see it is what lets a profile show
 * an honest "synced 2 minutes ago" rather than staying blank until you press
 * the button yourself.
 *
 * @module store/syncStatusStore
 */

import { create } from "zustand";

export type SyncActivity =
  "idle" | "syncing" | "success" | "conflict" | "error";

export interface ProfileSyncStatus {
  activity: SyncActivity;
  error: string | null;
  /**
   * Things that went wrong without failing the sync — a sound that could not
   * be uploaded, say. Separate from `error` because a sync that succeeded with
   * warnings is not a failed sync, and reporting it as one (which the server
   * sync used to do) turns a partial success into a red banner.
   */
  warnings: string[];
  lastSyncedAt: number | null;
  /** A live change channel is connected. Only server sync has one. */
  live: boolean;
}

/**
 * Shared, frozen, and returned by reference for every profile with no entry.
 * A selector that built a fresh object each call would give React a new
 * identity on every render and loop forever.
 */
export const IDLE_SYNC_STATUS: ProfileSyncStatus = Object.freeze({
  activity: "idle" as const,
  error: null,
  warnings: Object.freeze([]) as unknown as string[],
  lastSyncedAt: null,
  live: false,
});

interface SyncStatusStoreState {
  byProfileId: Map<number, ProfileSyncStatus>;
  actions: {
    patch: (profileId: number, patch: Partial<ProfileSyncStatus>) => void;
    /** Record a completed sync: clears the error and stamps the time. */
    noteSynced: (profileId: number, at: number) => void;
    clear: (profileId: number) => void;
    clearAll: () => void;
  };
}

export const useSyncStatusStore = create<SyncStatusStoreState>((set) => ({
  byProfileId: new Map(),
  actions: {
    patch: (profileId, patch) =>
      set((state) => {
        const current = state.byProfileId.get(profileId) ?? IDLE_SYNC_STATUS;
        const next = { ...current, ...patch };
        const byProfileId = new Map(state.byProfileId);
        byProfileId.set(profileId, next);
        return { byProfileId };
      }),

    noteSynced: (profileId, at) =>
      set((state) => {
        const current = state.byProfileId.get(profileId) ?? IDLE_SYNC_STATUS;
        const byProfileId = new Map(state.byProfileId);
        byProfileId.set(profileId, {
          ...current,
          activity: "success",
          error: null,
          lastSyncedAt: at,
        });
        return { byProfileId };
      }),

    clear: (profileId) =>
      set((state) => {
        if (!state.byProfileId.has(profileId)) return state;
        const byProfileId = new Map(state.byProfileId);
        byProfileId.delete(profileId);
        return { byProfileId };
      }),

    clearAll: () => set({ byProfileId: new Map() }),
  },
}));

export const syncStatusActions = useSyncStatusStore.getState().actions;

/** A profile's live sync status, or the shared idle record if it has none. */
export const useProfileSyncStatus = (
  profileId: number | null | undefined,
): ProfileSyncStatus =>
  useSyncStatusStore((state) =>
    profileId == null
      ? IDLE_SYNC_STATUS
      : (state.byProfileId.get(profileId) ?? IDLE_SYNC_STATUS),
  );
