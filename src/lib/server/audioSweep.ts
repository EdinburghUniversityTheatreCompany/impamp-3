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

import { committedKeysAmong, prunePendingUploads } from "./audio";
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

/**
 * What one pass may cost.
 *
 * A parameter rather than three constants because the traversal is the part
 * worth testing and no test can build ten thousand objects. `sweepIfDue` and
 * the schedule both use `SWEEP_LIMITS`; nothing in production passes anything
 * else.
 */
export interface SweepLimits {
  /**
   * Objects examined per pass.
   *
   * Committed objects count against this, and there is no way round that: an
   * object cannot be told from an orphan without looking it up. What makes
   * the budget mean something is the other two halves of this module — the
   * cursor, so each pass spends the budget on keys the last pass did not
   * reach, and the batched lookup below, so the per-object cost is a set
   * membership test rather than a synchronous SQLite query. Ten thousand is
   * ten list round trips and ten queries.
   */
  maxScanned: number;
  /** Keys asked of the bucket per list request. S3 caps this at 1000. */
  listPageSize: number;
  /** Deletes attempted per pass. The next sweep picks up whatever is left. */
  maxRemoved: number;
}

const SWEEP_LIMITS: SweepLimits = {
  maxScanned: 10_000,
  listPageSize: 1000,
  maxRemoved: 100,
};

/** How often a sweep is worth running when there is nothing left to walk. */
export const MIN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How soon a pass that stopped mid-bucket may be followed by the next.
 *
 * A pass that ran out of budget knows there is more bucket behind its cursor.
 * Waiting the full hour would then walk a large library at one pass an hour —
 * 200k objects is most of a day just to look at every key once — while the
 * bytes being looked for are billed for ninety days whether anyone finds them
 * or not.
 */
export const RESUME_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface SweepResult {
  scanned: number;
  removed: number;
  /**
   * True when the pass stopped at a cap with listing left, so the next one
   * resumes from its cursor rather than starting over.
   *
   * Read by `sweepIfDue`, which brings the next pass forward when it is set.
   */
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
 * Where the next pass starts, or null for the top of the listing.
 *
 * Module scope, beside `nextSweepAt`, because this is the whole of the fix to
 * a sweep that could never see past its own scan cap: the token was a local,
 * so every pass began again at the first key in the bucket and stopped in the
 * same place. On a deployment holding more objects than the cap, that made the
 * sweep unable to reach anything — measured at 1200 committed objects plus one
 * ten-day-old orphan sorting last: three consecutive passes each reported
 * `scanned: 1000, removed: 0` while the same object in an empty bucket was
 * removed at once.
 *
 * A plain key rather than a continuation token on purpose. A token is opaque
 * and means something only inside the listing that produced it; this one has
 * to survive an hour of ordinary traffic between passes.
 *
 * In memory, so it restarts at the top after a deploy. That is the safe
 * direction to be wrong in: the cost is re-examining keys, and a full circuit
 * happens anyway.
 */
let resumeAfterKey: string | null = null;

/**
 * Remove uncommitted objects older than the grace period.
 *
 * Bounded work, resumed across passes, rather than one long walk: this app is
 * a single instance whose event loop serves every request, and `node:sqlite`
 * is synchronous, so a sweep that read a whole large bucket in one go would
 * hold the process for as long as it took.
 *
 * @returns What the pass looked at and what it removed
 */
export async function sweepUncommittedObjects({
  store,
  config,
  now = Date.now(),
  limits = SWEEP_LIMITS,
}: {
  store: ObjectStore;
  config: AudioHostingConfig;
  now?: number;
  limits?: SweepLimits;
}): Promise<SweepResult> {
  const graceMs = config.uploadUrlTtlSeconds * 1000 + EXTRA_GRACE_MS;

  // The database half of the same housekeeping: a mint whose presigned URL has
  // expired is no longer charged for, so its row is only taking up space. The
  // upload path prunes as it goes, which covers everyone who comes back; this
  // covers whoever does not.
  prunePendingUploads(now - config.uploadUrlTtlSeconds * 1000);

  const startAfter = resumeAfterKey ?? undefined;
  let continuationToken: string | undefined;
  let scanned = 0;
  let removed = 0;
  let lastKey: string | null = null;

  /** Record where the next pass should pick up, and report this one. */
  const stopAt = (key: string | null): SweepResult => {
    resumeAfterKey = key;
    return { scanned, removed, truncated: key !== null };
  };

  for (;;) {
    const budget = limits.maxScanned - scanned;
    if (budget <= 0) return stopAt(lastKey);

    const page = await store.list({
      prefix: AUDIO_PREFIX,
      // One or the other, never both: within a pass the bucket's own token is
      // what continues the listing, and across passes only a plain key still
      // names a position. S3 ignores `start-after` when a token is present.
      ...(continuationToken ? { continuationToken } : { startAfter }),
      maxKeys: Math.min(limits.listPageSize, budget),
    });

    // Aged objects whose key is one of ours, key -> hash. Anything newer than
    // the grace period, or not shaped like a key we mint, never reaches the
    // database.
    const candidates = new Map<string, string>();
    for (const object of page.objects) {
      if (now - object.lastModifiedMs < graceMs) continue;
      const hash = hashForKey(object.key);
      if (hash) candidates.set(object.key, hash);
    }

    // One query for the page rather than one per object. `node:sqlite` is
    // synchronous and this runs on the thread serving requests, so a thousand
    // round trips per page is a thousand chances to be the reason a request
    // waited.
    const committedKeys = committedKeysAmong([...candidates.values()]);

    for (const object of page.objects) {
      scanned++;
      lastKey = object.key;

      // By key, never by hash. A hash can name two keys — the same bytes
      // offered under two extensions mint two — and only one of them ever
      // gets a row, so asking whether the *hash* is committed protects the
      // abandoned twin on every pass forever.
      if (!candidates.has(object.key) || committedKeys.has(object.key))
        continue;

      await store.remove(object.key);
      removed++;
      // Same as the scan cap, and it used to leave with nothing recorded: the
      // next pass then re-examined everything in front of whatever it had just
      // deleted.
      if (removed >= limits.maxRemoved) return stopAt(object.key);
    }

    if (!page.nextContinuationToken) break;
    continuationToken = page.nextContinuationToken;
  }

  // The end of the listing, so the next pass starts at the top again — the
  // only way an object uploaded in front of the cursor is ever looked at.
  return stopAt(null);
}

/** The earliest a sweep may next run. */
let nextSweepAt = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Forget the schedule and the cursor, and stop the timer. Tests only. */
export function resetSweepScheduleForTests(): void {
  nextSweepAt = 0;
  resumeAfterKey = null;
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
 * `sweepIfDue` — both go through the same throttle, so the two cannot double
 * up.
 *
 * The tick is the resume interval rather than the hourly one because
 * `sweepIfDue` is what decides how long to wait: an idle deployment still
 * sweeps at most hourly, and one whose last pass stopped mid-bucket gets its
 * next pass five minutes later instead of in an hour. Ticking hourly would put
 * that decision out of reach.
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
  }, RESUME_SWEEP_INTERVAL_MS);

  sweepTimer.unref?.();
}

/**
 * Run a sweep if one is due, swallowing storage failures.
 *
 * Called both by the timer above and by the admin audio page, so it runs when
 * somebody is already looking at storage as well as when nobody is. A bucket
 * that is unreachable must not take that page down with it, so a failure is
 * logged and reported as `null`.
 *
 * How long until the next one is the pass's own answer: an hour when it walked
 * the listing to the end, `RESUME_SWEEP_INTERVAL_MS` when it stopped at a cap
 * with a cursor pointing at the rest. That is what `truncated` is for.
 *
 * @returns The sweep's result, or null if one was not due or it failed
 */
export async function sweepIfDue(
  hosting: { store: ObjectStore; config: AudioHostingConfig },
  now = Date.now(),
  limits: SweepLimits = SWEEP_LIMITS,
): Promise<SweepResult | null> {
  if (now < nextSweepAt) return null;
  // Claimed before the first await, so two overlapping callers cannot both
  // sweep and a throw still leaves the hour's throttle in place.
  nextSweepAt = now + MIN_SWEEP_INTERVAL_MS;

  try {
    const result = await sweepUncommittedObjects({ ...hosting, now, limits });
    if (result.truncated) nextSweepAt = now + RESUME_SWEEP_INTERVAL_MS;
    return result;
  } catch (error) {
    console.error("Sweeping uncommitted audio objects failed:", error);
    return null;
  }
}
