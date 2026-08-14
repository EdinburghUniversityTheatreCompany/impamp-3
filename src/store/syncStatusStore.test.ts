import { beforeEach, describe, expect, it } from "vitest";
import {
  IDLE_SYNC_STATUS,
  syncStatusActions,
  useSyncStatusStore,
} from "@/store/syncStatusStore";

const read = (profileId: number) =>
  useSyncStatusStore.getState().byProfileId.get(profileId);

describe("syncStatusStore", () => {
  beforeEach(() => {
    syncStatusActions.clearAll();
  });

  it("starts every profile idle", () => {
    expect(read(1)).toBeUndefined();
    expect(IDLE_SYNC_STATUS.activity).toBe("idle");
    expect(IDLE_SYNC_STATUS.lastSyncedAt).toBeNull();
  });

  it("hands out the same idle record every time", () => {
    // A selector that built a fresh object per call would hand React a new
    // identity on every render and never settle.
    const first =
      useSyncStatusStore.getState().byProfileId.get(1) ?? IDLE_SYNC_STATUS;
    const second =
      useSyncStatusStore.getState().byProfileId.get(1) ?? IDLE_SYNC_STATUS;
    expect(first).toBe(second);
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
    syncStatusActions.patch(1, { live: true });

    expect(read(1)).toMatchObject({ lastSyncedAt: 1_000, live: true });
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
