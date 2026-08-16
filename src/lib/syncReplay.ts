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
export function replaySyncOutcome(
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
export function fanOutSyncCallbacks<C extends FanOutable>(
  listeners: Set<C>,
): C {
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
