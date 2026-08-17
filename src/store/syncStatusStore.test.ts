import { beforeEach, describe, expect, it } from "vitest";
import type { ItemConflict } from "@/lib/syncUtils";
import type { SyncConflictData } from "@/lib/googleDrive/types";
import {
  IDLE_SYNC_STATUS,
  mirrorToProfile,
  selectProfileSyncStatus,
  syncStatusActions,
  useSyncStatusStore,
} from "@/store/syncStatusStore";

const read = (profileId: number) =>
  useSyncStatusStore.getState().byProfileId.get(profileId);

/**
 * Every sink the wrapper might delegate to, recording what each one saw.
 *
 * One recorder rather than five spies, because the point of the table below is
 * that exactly one delegate fires per callback — a wrapper that called two, or
 * the wrong one, has to be visible.
 */
function sinks() {
  const seen: Array<[string, unknown]> = [];
  const record = (name: string) => (value: unknown) => {
    seen.push([name, value]);
  };
  return {
    seen,
    callbacks: {
      onStatusChange: record("onStatusChange"),
      onError: record("onError"),
      onWarnings: record("onWarnings"),
      onConflictsDetected: record("onConflictsDetected"),
      onConflictDataAvailable: record("onConflictDataAvailable"),
    },
    local: {
      setConflicts: record("setConflicts"),
      setConflictData: record("setConflictData"),
    },
  };
}

const A_CONFLICT = {
  storeName: "profiles",
  key: 1,
  id: 1,
  type: "field_conflict",
} as unknown as ItemConflict;

const CONFLICT_DATA = {
  profileId: 1,
} as unknown as SyncConflictData;

describe("syncStatusStore", () => {
  beforeEach(() => {
    syncStatusActions.clearAll();
  });

  // The sync that finds a problem is almost never the one a profile card is
  // holding: scheduled and SSE-driven syncs run in ClientSideInitializer's
  // hook instance, and hook state does not cross instances. Anything this
  // wrapper fails to mirror is therefore stored where nothing can read it —
  // which is what happened to warnings, and what this file used to test one
  // callback out of five for. Deleting the other four `patch` calls left the
  // whole suite green.
  it.each([
    ["onStatusChange", "syncing", "activity", "onStatusChange"],
    ["onError", "the server said no", "error", "onError"],
    ["onWarnings", ["horn.mp3: could not be downloaded"], "warnings", "onWarnings"], // prettier-ignore
    ["onConflictsDetected", [A_CONFLICT], "conflicts", "setConflicts"],
    ["onConflictDataAvailable", CONFLICT_DATA, "conflictData", "setConflictData"], // prettier-ignore
  ] as const)(
    "carries a background sync's %s to where a card can see it",
    (callback, argument, field, delegate) => {
      const s = sinks();
      const mirrored = mirrorToProfile(
        7,
        s.callbacks,
        s.local,
      ) as unknown as Record<string, (value: unknown) => void>;

      mirrored[callback](argument);

      expect(read(7)?.[field]).toEqual(argument);
      // The engine's own callback still runs, and nothing else does.
      expect(s.seen).toEqual([[delegate, argument]]);
    },
  );

  it("starts every profile idle", () => {
    expect(read(1)).toBeUndefined();
    expect(IDLE_SYNC_STATUS.activity).toBe("idle");
    expect(IDLE_SYNC_STATUS.lastSyncedAt).toBeNull();
  });

  it("hands out the same idle record every time", () => {
    // A selector that built a fresh object per call would hand React a new
    // identity on every render and never settle. This used to write the `??`
    // fallback out in the test rather than calling the selector, so it
    // asserted IDLE_SYNC_STATUS === IDLE_SYNC_STATUS and the real selector was
    // never called by this file at all.
    const state = useSyncStatusStore.getState();

    expect(selectProfileSyncStatus(state, 1)).toBe(
      selectProfileSyncStatus(state, 1),
    );
    expect(selectProfileSyncStatus(state, 1)).toBe(IDLE_SYNC_STATUS);
  });

  it("hands out the idle record for no profile at all", () => {
    // ProfileCard renders before a profile id exists, so this branch is on the
    // first render of every card.
    const state = useSyncStatusStore.getState();

    expect(selectProfileSyncStatus(state, null)).toBe(IDLE_SYNC_STATUS);
    expect(selectProfileSyncStatus(state, undefined)).toBe(IDLE_SYNC_STATUS);
  });

  it("hands out a stored status by reference, not a copy", () => {
    // The stable-identity requirement is not only about the idle record: a
    // profile that *is* syncing re-renders on every unrelated store write if
    // its status arrives as a fresh object each time.
    syncStatusActions.patch(1, { activity: "syncing" });
    const state = useSyncStatusStore.getState();

    expect(selectProfileSyncStatus(state, 1)).toBe(state.byProfileId.get(1));
    expect(selectProfileSyncStatus(state, 1)).toBe(
      selectProfileSyncStatus(state, 1),
    );
  });

  it("refuses to be mutated in place", () => {
    expect(() => {
      (IDLE_SYNC_STATUS as { activity: string }).activity = "syncing";
    }).toThrow();
  });

  it("patches one profile without touching another", () => {
    syncStatusActions.patch(1, { activity: "syncing" });
    syncStatusActions.patch(2, { activity: "error", error: "nope" });

    expect(read(1)?.activity).toBe("syncing");
    expect(read(1)?.error).toBeNull();
    expect(read(2)?.error).toBe("nope");
  });

  it("keeps earlier fields when patching a later one", () => {
    syncStatusActions.noteSynced(1, 1_000);
    syncStatusActions.patch(1, { activity: "syncing" });

    expect(read(1)).toMatchObject({
      lastSyncedAt: 1_000,
      activity: "syncing",
    });
  });

  it("clears the error when a sync completes", () => {
    syncStatusActions.patch(1, { activity: "error", error: "was broken" });
    syncStatusActions.noteSynced(1, 2_000);

    expect(read(1)).toMatchObject({
      activity: "success",
      error: null,
      lastSyncedAt: 2_000,
    });
  });

  it("keeps warnings distinct from errors", () => {
    // A sync that finished with warnings is not a failed sync. Reporting it
    // through the error channel is what made a partial success look red.
    syncStatusActions.patch(1, {
      activity: "success",
      warnings: ["one sound could not be uploaded"],
    });

    expect(read(1)?.activity).toBe("success");
    expect(read(1)?.error).toBeNull();
    expect(read(1)?.warnings).toHaveLength(1);
  });

  it("replaces the map so subscribers actually wake", () => {
    const before = useSyncStatusStore.getState().byProfileId;
    syncStatusActions.patch(1, { activity: "syncing" });
    expect(useSyncStatusStore.getState().byProfileId).not.toBe(before);
  });

  it("does not churn the map when clearing a profile it never had", () => {
    const before = useSyncStatusStore.getState().byProfileId;
    syncStatusActions.clear(99);
    expect(useSyncStatusStore.getState().byProfileId).toBe(before);
  });

  it("forgets a profile on request", () => {
    syncStatusActions.patch(1, { activity: "syncing" });
    syncStatusActions.clear(1);
    expect(read(1)).toBeUndefined();
  });
});
