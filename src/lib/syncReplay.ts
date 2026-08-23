/**
 * Telling a caller that joined a running sync how it ended.
 *
 * Both backends coalesce concurrent syncs for one profile into a single run,
 * and a caller that joins can arrive *after* the terminal callback has already
 * fired — so the outcome is replayed from the result rather than only
 * forwarded as it happens. Setting the same terminal state twice is harmless;
 * never setting it is what leaves a card claiming a sync is still going, with
 * its button disabled, until the panel is closed and reopened.
 *
 * Shared rather than written once per backend, because writing it twice is how
 * this codebase produces bugs: jscpd refused the commit that had two copies of
 * it, which is exactly what that gate is for.
 *
 * The same goes for the fan-out below: a run reports to whoever is waiting at
 * the time, not only to whoever started it.
 *
 * And for the coalescing itself. Extracting the replay and the fan-out left
 * the wrapper that calls them written out twice — two maps, the join branch,
 * the listener set, the `finally` that empties both — identical in the two
 * backends down to the comments. That is the shape this repo's sync bugs keep
 * taking: one rule written twice, fixed in one copy. The Drive backend got the
 * joiner's callbacks wired up months before the server backend did, and the
 * comment in `serverSync/sync.ts` still says so.
 *
 * @module lib/syncReplay
 */

import type { ItemConflict } from "./syncUtils";

/** The four states a finished run can be replayed into. */
export type ReplayableStatus = "idle" | "success" | "error" | "conflict";

/** As much of a sync result as replaying the outcome depends on. */
export type ReplayableResult =
  | { status: "success" }
  | { status: "error"; error: string }
  | { status: "conflict"; conflicts?: ItemConflict[] }
  | { status: string };

export interface ReplayableCallbacks {
  onStatusChange: (status: ReplayableStatus) => void;
  onError: (error: string | null) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
}

/**
 * Reports a finished run's outcome to a caller that missed the live events.
 *
 * Anything that is not success, error or conflict — "unchanged", "skipped",
 * "paused" — settles as idle: nothing is wrong, and nothing is still running.
 *
 * @param result - The finished run's result
 * @param callbacks - The joiner's callbacks
 */
function replaySyncOutcome(
  result: ReplayableResult,
  callbacks: ReplayableCallbacks,
): void {
  switch (result.status) {
    case "success":
      callbacks.onError(null);
      callbacks.onStatusChange("success");
      break;
    case "error":
      callbacks.onError((result as { error: string }).error);
      callbacks.onStatusChange("error");
      break;
    case "conflict":
      callbacks.onConflictsDetected(
        (result as { conflicts?: ItemConflict[] }).conflicts ?? [],
      );
      callbacks.onStatusChange("conflict");
      break;
    default:
      callbacks.onStatusChange("idle");
  }
}

/** The callbacks a run fans out to, as far as this module is concerned. */
interface FanOutable {
  onStatusChange: (status: never) => void;
  onError: (error: string | null) => void;
  onWarnings?: (warnings: string[]) => void;
  onConflictsDetected: (conflicts: ItemConflict[]) => void;
  onConflictDataAvailable?: (data: never) => void;
}

/**
 * One callback object that forwards to every listener currently waiting.
 *
 * Reads the set at call time rather than copying it, so a caller that joins
 * mid-run starts hearing events immediately and one that leaves stops.
 *
 * @param listeners - The live set of waiting callbacks
 * @returns Callbacks of the same shape, forwarding to all of them
 */
function fanOutSyncCallbacks<C extends FanOutable>(listeners: Set<C>): C {
  const each = (run: (one: C) => void) => listeners.forEach(run);

  return {
    onStatusChange: (status: never) =>
      each((one) => one.onStatusChange(status)),
    onError: (error: string | null) => each((one) => one.onError(error)),
    onWarnings: (warnings: string[]) =>
      each((one) => one.onWarnings?.(warnings)),
    onConflictsDetected: (conflicts: ItemConflict[]) =>
      each((one) => one.onConflictsDetected(conflicts)),
    onConflictDataAvailable: (data: never) =>
      each((one) => one.onConflictDataAvailable?.(data)),
  } as unknown as C;
}

/**
 * The runs a backend has in flight, and who is waiting on each.
 *
 * One registry per backend rather than one shared map: the two key the same
 * profile ids, and a Drive sync joining a server sync would be a category
 * error, not a saving.
 */
export interface SyncRunRegistry<R, C> {
  /** The promise for each profile's running sync. */
  runs: Map<number, Promise<R>>;
  /** Everyone waiting on it, including whoever started it. */
  listeners: Map<number, Set<C>>;
}

/** A fresh, empty registry. */
export function createSyncRunRegistry<R, C>(): SyncRunRegistry<R, C> {
  return { runs: new Map(), listeners: new Map() };
}

/**
 * Run a sync for a profile, or join the one already running.
 *
 * Concurrent syncs for one profile are common rather than exotic — sign-in,
 * an SSE notification, the edit debounce and a manual press can all land at
 * once — so a second caller shares the first run's promise. What it must also
 * share is the *reporting*: a joiner is added to the live listener set so it
 * hears events from here on, and is replayed the outcome when the run ends,
 * because the terminal callback may already have fired before it arrived.
 * Without that a card that pressed "Sync now" during a background sync sat on
 * "syncing" with its button disabled until the panel was closed and reopened.
 *
 * @param registry - This backend's in-flight runs
 * @param profileId - The profile being synced
 * @param callbacks - This caller's callbacks
 * @param start - Starts a real run, reporting to the callbacks it is given
 * @returns The run's result, shared with everyone else waiting on it
 */
export function coalesceSyncRun<
  R extends ReplayableResult,
  C extends FanOutable & ReplayableCallbacks,
>(
  registry: SyncRunRegistry<R, C>,
  profileId: number,
  callbacks: C,
  start: (fanOut: C) => Promise<R>,
): Promise<R> {
  const running = registry.runs.get(profileId);
  if (running) {
    console.log(
      `Sync already running for profile ${profileId} — joining in-flight run`,
    );
    const listeners = registry.listeners.get(profileId);
    listeners?.add(callbacks);
    return running.then((result) => {
      listeners?.delete(callbacks);
      replaySyncOutcome(result, callbacks);
      return result;
    });
  }

  const listeners = new Set<C>([callbacks]);
  registry.listeners.set(profileId, listeners);

  const run = start(fanOutSyncCallbacks(listeners)).finally(() => {
    registry.runs.delete(profileId);
    registry.listeners.delete(profileId);
  });

  registry.runs.set(profileId, run);
  return run;
}
