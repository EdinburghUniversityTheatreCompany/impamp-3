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
import type { ItemConflict } from "@/lib/syncUtils";
import type { SyncConflictData } from "@/lib/googleDrive/types";

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
  /**
   * A conflict waiting for a human, and the three versions it is between.
   *
   * Here rather than in the sync hooks because the sync that finds a conflict
   * is usually not the one a profile card is holding: the scheduled syncs run
   * in `ClientSideInitializer`'s hook instance, and hook state does not cross
   * instances. A conflict found in the background would otherwise be detected,
   * recorded, and never shown to anyone.
   */
  conflicts: ItemConflict[];
  conflictData: SyncConflictData | null;
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
  conflicts: Object.freeze([]) as unknown as ItemConflict[],
  conflictData: null,
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

/**
 * A profile's live sync status, or the shared idle record if it has none.
 *
 * Exported separately from the hook below because what matters about it is the
 * *identity* it returns — React 19's `useSyncExternalStore` treats a fresh
 * object per call as "getSnapshot should be cached", which is an infinite
 * re-render rather than a wrong value — and a hook cannot be called outside
 * React. The unit suite runs in the node environment with no DOM, so the only
 * way to hold this function to that property is to be able to call it.
 */
export const selectProfileSyncStatus = (
  state: Pick<SyncStatusStoreState, "byProfileId">,
  profileId: number | null | undefined,
): ProfileSyncStatus =>
  profileId == null
    ? IDLE_SYNC_STATUS
    : (state.byProfileId.get(profileId) ?? IDLE_SYNC_STATUS);

/** A profile's live sync status, or the shared idle record if it has none. */
export const useProfileSyncStatus = (
  profileId: number | null | undefined,
): ProfileSyncStatus =>
  useSyncStatusStore((state) => selectProfileSyncStatus(state, profileId));

/**
 * Wrap a sync engine's callbacks so everything they report also lands in the
 * shared store, keyed by profile.
 *
 * Both engines need exactly this and had it written out separately, which is
 * how they drifted: only the conflict half was ever bound, so a background
 * sync's status and errors stayed inside `ClientSideInitializer`'s hook
 * instance and no card could see them.
 */
export function mirrorToProfile<
  C extends {
    onStatusChange: (activity: never) => void;
    onError: (error: string | null) => void;
    onConflictsDetected: (conflicts: ItemConflict[]) => void;
    onConflictDataAvailable?: (data: SyncConflictData | null) => void;
  },
>(
  profileId: number,
  callbacks: C,
  local: {
    setConflicts: (conflicts: ItemConflict[]) => void;
    setConflictData: (data: SyncConflictData | null) => void;
  },
): C {
  return {
    ...callbacks,
    onStatusChange: (activity: SyncActivity) => {
      (callbacks.onStatusChange as (a: SyncActivity) => void)(activity);
      syncStatusActions.patch(profileId, { activity });
    },
    onError: (error: string | null) => {
      callbacks.onError(error);
      // Clearing warnings alongside a *new* error state would be wrong, but a
      // successful sync reports its warnings after onStatusChange, so they
      // land after this and survive.
      syncStatusActions.patch(profileId, { error });
    },
    onWarnings: (warnings: string[]) => {
      (callbacks as { onWarnings?: (w: string[]) => void }).onWarnings?.(
        warnings,
      );
      // Without this the whole channel was write-only for background syncs.
      // They run in ClientSideInitializer's hook instance, so a warning raised
      // there was stored where no profile card could ever see it — the exact
      // shape this store was introduced to fix.
      syncStatusActions.patch(profileId, { warnings });
    },
    onConflictsDetected: (conflicts: ItemConflict[]) => {
      local.setConflicts(conflicts);
      syncStatusActions.patch(profileId, { conflicts });
    },
    onConflictDataAvailable: (conflictData: SyncConflictData | null) => {
      local.setConflictData(conflictData);
      syncStatusActions.patch(profileId, { conflictData });
    },
  } as unknown as C;
}
