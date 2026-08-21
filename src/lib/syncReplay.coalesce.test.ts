/**
 * What a caller that joins a running sync is owed.
 *
 * Three things, and each of them was a bug at some point: the run itself
 * (started once, not twice), the events from the moment it joined, and the
 * outcome at the end — because the terminal callback has very often already
 * fired by the time it arrives, and a joiner that hears nothing is a card
 * stuck on "syncing" with its button disabled.
 *
 * These assertions used to be answerable only through a backend, and the
 * wrapper that provides them was written out once per backend. They now sit on
 * the wrapper, so neither copy can drift.
 */
import { describe, expect, it, vi } from "vitest";
import {
  coalesceSyncRun,
  createSyncRunRegistry,
  type ReplayableStatus,
} from "./syncReplay";
import type { ItemConflict } from "./syncUtils";

interface Callbacks {
  onStatusChange: (status: ReplayableStatus) => void;
  onError: (error: string | null) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
}

type Result =
  | { status: "success" }
  | { status: "error"; error: string }
  | { status: "conflict"; conflicts?: ItemConflict[] }
  | { status: "skipped" };

function spy(): Callbacks & { statuses: ReplayableStatus[] } {
  const statuses: ReplayableStatus[] = [];
  return {
    statuses,
    onStatusChange: (status) => statuses.push(status),
    onError: vi.fn(),
    onConflictsDetected: vi.fn(),
  };
}

/** A run that finishes only when the test says so. */
function deferred(): {
  promise: Promise<Result>;
  finish: (result: Result) => void;
} {
  let finish!: (result: Result) => void;
  const promise = new Promise<Result>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

const PROFILE = 7;

describe("joining a sync that is already running", () => {
  it("does not start a second one", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const start = vi.fn(() => run.promise);

    const first = coalesceSyncRun(registry, PROFILE, spy(), start);
    const second = coalesceSyncRun(registry, PROFILE, spy(), start);

    run.finish({ status: "success" });
    await Promise.all([first, second]);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("hears the outcome it arrived too late to see live", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const starter = spy();
    const joiner = spy();

    const first = coalesceSyncRun(registry, PROFILE, starter, (fanOut) => {
      // The live terminal event, which only the starter is there for.
      fanOut.onStatusChange("success");
      return run.promise;
    });
    const second = coalesceSyncRun(registry, PROFILE, joiner, () => {
      throw new Error("should not start a second run");
    });

    run.finish({ status: "success" });
    await Promise.all([first, second]);

    expect(joiner.statuses).toEqual(["success"]);
  });

  it("hears events raised after it joined", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const joiner = spy();
    let live!: Callbacks;

    const first = coalesceSyncRun(registry, PROFILE, spy(), (fanOut) => {
      live = fanOut;
      return run.promise;
    });
    const second = coalesceSyncRun(registry, PROFILE, joiner, () => {
      throw new Error("should not start a second run");
    });

    // Deliberately not the outcome: a run that ends in success replays
    // `onError(null)`, so asserting on an error the *result* also carries
    // would pass whether or not the joiner was ever added to the live set.
    live.onError("Drive is being slow");
    run.finish({ status: "success" });
    await Promise.all([first, second]);

    expect(joiner.onError).toHaveBeenCalledWith("Drive is being slow");
  });

  it("is replayed a conflict as a conflict, not as a failure", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const joiner = spy();
    const conflicts = [{ id: "pad-1" }] as unknown as ItemConflict[];

    const first = coalesceSyncRun(registry, PROFILE, spy(), () => run.promise);
    const second = coalesceSyncRun(registry, PROFILE, joiner, () => {
      throw new Error("should not start a second run");
    });

    run.finish({ status: "conflict", conflicts });
    await Promise.all([first, second]);

    expect(joiner.onConflictsDetected).toHaveBeenCalledWith(conflicts);
    expect(joiner.statuses).toEqual(["conflict"]);
  });

  it("settles at idle for an outcome that is neither good nor bad", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const joiner = spy();

    const first = coalesceSyncRun(registry, PROFILE, spy(), () => run.promise);
    const second = coalesceSyncRun(registry, PROFILE, joiner, () => {
      throw new Error("should not start a second run");
    });

    run.finish({ status: "skipped" });
    await Promise.all([first, second]);

    expect(joiner.statuses).toEqual(["idle"]);
  });
});

describe("after a run ends", () => {
  it("leaves nothing behind, so the next sync really runs", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const run = deferred();
    const start = vi.fn(() => run.promise);

    const first = coalesceSyncRun(registry, PROFILE, spy(), start);
    run.finish({ status: "success" });
    await first;

    expect(registry.runs.size).toBe(0);
    expect(registry.listeners.size).toBe(0);

    await coalesceSyncRun(registry, PROFILE, spy(), () =>
      Promise.resolve({ status: "success" as const }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing behind when it fails, either", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();

    await expect(
      coalesceSyncRun(registry, PROFILE, spy(), () =>
        Promise.reject(new Error("network")),
      ),
    ).rejects.toThrow("network");

    // A run that throws still has to clear the way for the next one. It used
    // to be the `finally` on a promise written per backend; it is one `finally`
    // now, but the guarantee is the same.
    expect(registry.runs.size).toBe(0);
    expect(registry.listeners.size).toBe(0);
  });

  it("keeps two profiles apart", async () => {
    const registry = createSyncRunRegistry<Result, Callbacks>();
    const one = deferred();
    const two = deferred();
    const startOne = vi.fn(() => one.promise);
    const startTwo = vi.fn(() => two.promise);

    const a = coalesceSyncRun(registry, PROFILE, spy(), startOne);
    const b = coalesceSyncRun(registry, PROFILE + 1, spy(), startTwo);

    one.finish({ status: "success" });
    two.finish({ status: "success" });
    await Promise.all([a, b]);

    expect(startOne).toHaveBeenCalledTimes(1);
    expect(startTwo).toHaveBeenCalledTimes(1);
  });
});
