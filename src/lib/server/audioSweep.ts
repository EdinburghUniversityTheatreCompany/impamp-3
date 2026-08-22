/**
 * Removing bucket objects that were uploaded and never committed.
 *
 * `upload-url` mints a presigned PUT and returns. The presign signs only
 * `host`, so the URL constrains neither size nor content, and the size the
 * client declared is only a claim. If the browser then PUTs and never calls
 * commit — a closed tab, a lost connection, a refused quota check on the
 * client side — no `audio_objects` row is written. From that moment the bytes
 * are unreachable: no quota counts them, the admin view sums `audio_objects`
 * so it cannot show them, and there is no API that could delete them. Wasabi
 * bills a 90-day minimum for each one.
 *
 * So something has to go looking. This is that something. It needs no
 * scheduler: the app is documented and deployed as a single instance, so a
 * module-level "when did this last run" is the whole of the coordination
 * required, and the admin page is a natural place to hang it off.
 *
 * Server-only.
 */

import { getAudioObject, prunePendingUploads } from "./audio";
import type { AudioHostingConfig } from "./s3/config";
import type { ObjectStore } from "./s3/client";

/** Everything hosted audio writes lives under this prefix. */
const AUDIO_PREFIX = "audio/";

/**
 * How long after an upload URL expires an uncommitted object is fair game.
 *
 * The upload TTL is the window in which a PUT can still be arriving; the extra
 * hour covers a commit that is slow rather than absent. Erring long costs a
 * little storage, erring short deletes a file out from under someone
 * mid-upload.
 */
const EXTRA_GRACE_MS = 60 * 60 * 1000;

/** Objects considered per pass, so one sweep cannot become a long request. */
const MAX_SCANNED_PER_SWEEP = 1000;

/** Deletes attempted per pass. The next sweep picks up whatever is left. */
const MAX_REMOVED_PER_SWEEP = 100;

/** How often a sweep is worth running at all. */
export const MIN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SweepResult {
  scanned: number;
  removed: number;
  /** True when the pass stopped at a cap rather than at the end of the bucket. */
  truncated: boolean;
}

/**
 * The hash a key stands for, or null if the key is not one we mint.
 *
 * Anything unrecognised is left alone. A sweep that deletes keys it does not
 * understand is a sweep that eats whatever else the bucket is used for.
 */
function hashForKey(key: string): string | null {
  return (
    /^audio\/[0-9a-f]{2}\/([0-9a-f]{64})(?:\.[a-z0-9]+)?$/.exec(key)?.[1] ??
    null
  );
}

/**
 * Remove uncommitted objects older than the grace period.
 *
 * @returns What the pass looked at and what it removed
 */
export async function sweepUncommittedObjects({
  store,
  config,
  now = Date.now(),
}: {
  store: ObjectStore;
  config: AudioHostingConfig;
  now?: number;
}): Promise<SweepResult> {
  const graceMs = config.uploadUrlTtlSeconds * 1000 + EXTRA_GRACE_MS;

  // The database half of the same housekeeping: a mint whose presigned URL has
  // expired is no longer charged for, so its row is only taking up space. The
  // upload path prunes as it goes, which covers everyone who comes back; this
  // covers whoever does not.
  prunePendingUploads(now - config.uploadUrlTtlSeconds * 1000);

  let scanned = 0;
  let removed = 0;
  let truncated = false;
  let continuationToken: string | undefined;

  do {
    const page = await store.list({
      prefix: AUDIO_PREFIX,
      continuationToken,
      maxKeys: MAX_SCANNED_PER_SWEEP - scanned,
    });

    for (const object of page.objects) {
      scanned++;

      if (now - object.lastModifiedMs < graceMs) continue;

      const hash = hashForKey(object.key);
      if (!hash || getAudioObject(hash)) continue;

      await store.remove(object.key);
      removed++;
      if (removed >= MAX_REMOVED_PER_SWEEP) {
        return { scanned, removed, truncated: true };
      }
    }

    continuationToken = page.nextContinuationToken ?? undefined;
    if (continuationToken && scanned >= MAX_SCANNED_PER_SWEEP) {
      truncated = true;
      break;
    }
  } while (continuationToken);

  return { scanned, removed, truncated };
}

let lastSweepAt = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Forget when the last sweep ran, and stop the timer. Tests only. */
export function resetSweepScheduleForTests(): void {
  lastSweepAt = 0;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** Whether the periodic sweep is running in this process. Tests only. */
export function sweepIsScheduledForTests(): boolean {
  return sweepTimer !== null;
}

/**
 * Start the periodic sweep, once per process.
 *
 * It used to hang off the admin storage page and nothing else, on the
 * reasoning that a sweep should run when somebody is already looking at
 * storage. That makes the only recovery from uncommitted bytes depend on an
 * admin opening a page — which on a working deployment is approximately never,
 * while Wasabi bills a 90-day minimum for every object nobody swept. A caller
 * who PUTs and never commits was, in practice, storing indefinitely.
 *
 * A plain interval is the whole of the coordination needed: this app is
 * documented and deployed as a single instance. `unref` so it can never be the
 * reason the process stays alive, and the admin page keeps its own
 * `sweepIfDue` — both share the same "not more than hourly" throttle, so the
 * two cannot double up.
 */
export function ensureSweepScheduled(hosting: {
  store: ObjectStore;
  config: AudioHostingConfig;
}): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    // Not awaited by anyone, and `sweepIfDue` swallows storage failures, so an
    // unreachable bucket cannot become an unhandled rejection.
    void sweepIfDue(hosting);
  }, MIN_SWEEP_INTERVAL_MS);

  sweepTimer.unref?.();
}

/**
 * Run a sweep if one is due, swallowing storage failures.
 *
 * Hung off the admin audio page rather than a timer, so it runs when somebody
 * is already looking at storage and never on an idle instance. A bucket that
 * is unreachable must not take that page down with it, so a failure is logged
 * and reported as `null`.
 *
 * @returns The sweep's result, or null if one was not due or it failed
 */
export async function sweepIfDue(
  hosting: { store: ObjectStore; config: AudioHostingConfig },
  now = Date.now(),
): Promise<SweepResult | null> {
  if (now - lastSweepAt < MIN_SWEEP_INTERVAL_MS) return null;
  lastSweepAt = now;

  try {
    return await sweepUncommittedObjects({ ...hosting, now });
  } catch (error) {
    console.error("Sweeping uncommitted audio objects failed:", error);
    return null;
  }
}
