/**
 * Audio Module - Loudness analysis pipeline
 *
 * Analysis is never blocking. Imports are analysed in the same pass that
 * already decodes them; existing files are swept in the background on idle.
 * Until a file is analysed it resolves to 0 dB of normalisation and plays
 * exactly as it did before this feature existed.
 *
 * @module lib/audio/loudness/pipeline
 */

import {
  findUnanalysedAudioFileIds,
  getAudioFile,
  getAudioFileIdsForProfile,
  getAudioFileMetadata,
  updateAudioFileLoudness,
} from "@/lib/db";
import type { LoudnessAnalysis } from "./types";
import { getCachedAudioBuffer } from "@/lib/audio/cache";
import { decodeAudioBlob } from "@/lib/audio/decoder";
import { analyseAudioBufferOffThread } from "./analyseOffThread";
import { setCachedLoudness, warmLoudnessCache } from "./cache";
import { LOUDNESS_ALGO_VERSION } from "./constants";

/** How many files to analyse per idle slice. */
const BACKFILL_BATCH_SIZE = 3;

// Monotonic token so a superseded load can never write. A profile switch
// starts a new load; a slow load for the profile just left must abandon its
// result rather than clobber the one that replaced it. `runBackfill` no
// longer uses this pattern — see the coalescing state below.
let loadGeneration = 0;

// `runBackfill` coalesces rather than supersedes: the backfill queue is
// global (`findUnanalysedAudioFileIds` scans every audio file), so two
// callers genuinely want the same work, not a fight over who wins. A call
// that arrives while a run is in flight joins that run's promise instead of
// starting a competing one; if it also wants a re-run (because the queue
// was snapshotted at the start and files may have arrived since), it
// records that, and the in-flight run does exactly one more pass once it
// finishes before resolving.
let backfillInFlight: Promise<void> | null = null;
let backfillRerunRequested = false;

/**
 * Files that failed to decode this session. Kept in memory rather than
 * persisted so a transient failure gets another chance on next launch, while
 * a genuinely corrupt file costs one decode attempt per session instead of
 * one per profile switch (the backfill queue is rebuilt every switch, and
 * without this a permanently undecodable file would be retried forever).
 */
const failedAnalysis = new Set<number>();

/** Test-only: clears the failed-analysis set so tests don't leak state. */
export function clearFailedAnalysis(): void {
  failedAnalysis.clear();
}

export interface BackfillProgress {
  done: number;
  total: number;
}

// Last progress emitted, so a subscriber that mounts mid-backfill sees the
// current state instead of waiting for the next tick.
let backfillProgress: BackfillProgress = { done: 0, total: 0 };
const progressListeners = new Set<(p: BackfillProgress) => void>();

/**
 * Observes backfill progress without starting one.
 *
 * `runBackfill` coalesces concurrent callers (see the coalescing state
 * above), so it is safe to call from more than one place. UI that only
 * wants to display progress without itself deciding when a backfill should
 * run can still subscribe here instead.
 */
export function subscribeToBackfillProgress(
  listener: (progress: BackfillProgress) => void,
): () => void {
  progressListeners.add(listener);
  listener(backfillProgress);
  return () => {
    progressListeners.delete(listener);
  };
}

function emitBackfillProgress(done: number, total: number): void {
  backfillProgress = { done, total };
  for (const listener of progressListeners) listener(backfillProgress);
}

export function shouldAnalyse(loudness: LoudnessAnalysis | undefined): boolean {
  return !loudness || loudness.algoVersion !== LOUDNESS_ALGO_VERSION;
}

export function nextBackfillBatch(
  queue: number[],
  batchSize: number,
): number[] {
  return queue.slice(0, batchSize);
}

/**
 * Analyses one audio file and stores the result. Reuses an already-decoded
 * buffer when the cache has one, since decoding is the expensive part.
 */
export async function analyseAndStore(
  audioFileId: number,
): Promise<LoudnessAnalysis | null> {
  try {
    let buffer = getCachedAudioBuffer(audioFileId);

    if (!buffer) {
      const file = await getAudioFile(audioFileId);
      if (!file) return null;
      buffer = await decodeAudioBlob(file.blob);
    }

    // Off the main thread: this is ~2.2 seconds of arithmetic per minute of
    // stereo audio, and it used to run here, unqueued, once per file added.
    const analysis = await analyseAudioBufferOffThread(buffer);
    await updateAudioFileLoudness(audioFileId, analysis);
    setCachedLoudness(audioFileId, analysis);
    return analysis;
  } catch (error) {
    // A file we cannot decode simply stays unanalysed and plays at 0 dB.
    // Remember it for this session so the backfill queue stops offering it —
    // without this, a genuinely corrupt file gets re-decoded on every
    // startup and every profile switch forever.
    failedAnalysis.add(audioFileId);
    console.warn(
      `[Loudness] Could not analyse audio file ${audioFileId}:`,
      error,
    );
    return null;
  }
}

/**
 * Loads every stored, current analysis for a profile into the in-memory
 * cache, replacing whatever was resident.
 *
 * This is the only thing that honours the cache's caller contract
 * (`warmLoudnessCache` replaces the whole cache but nothing enforces when it
 * is called): every profile activation must call this, or the previous
 * profile's measurements stay resident and a different profile's sounds
 * resolve gain from them.
 *
 * Guarded by a generation token rather than by the caller cancelling: the
 * gathering below reads the profile's audio metadata in one pass, so a slow
 * load for profile A can still be in flight when the user switches to B and
 * B's own (faster) load has already warmed the cache. Without the token, A
 * would resolve afterwards and call `warmLoudnessCache` again, clobbering
 * B's data with A's — silently, since nothing throws. The token makes that
 * write conditional on this call still being the most recent one requested,
 * so only the newest `loadProfileLoudness` call for the currently active
 * profile is ever allowed to write.
 */
export async function loadProfileLoudness(profileId: number): Promise<void> {
  if (typeof window === "undefined") return;

  const generation = ++loadGeneration;
  const ids = await getAudioFileIdsForProfile(profileId);

  // One cursor pass reading only what it needs. This used to be
  // `for (const id of ids) await getAudioFile(id)`, which reads the *whole*
  // record — Blob included — to look at `.loudness`. On a 500-sound board that
  // is 500 sequential round trips materialising 500 audio files in memory, and
  // `refreshProfileLoudness` calls this twice, on every profile activation and
  // after every sync of the active profile.
  const metadata = await getAudioFileMetadata(ids);
  const entries: [number, LoudnessAnalysis][] = [];

  for (const [id, file] of metadata) {
    if (file.loudness && !shouldAnalyse(file.loudness)) {
      entries.push([id, file.loudness]);
    }
  }

  if (generation !== loadGeneration) return; // a newer load superseded this one
  warmLoudnessCache(entries);
}

/** Schedules work for when the browser is idle, falling back to a timer. */
function onIdle(callback: () => void): void {
  const ric = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
    }
  ).requestIdleCallback;

  if (typeof ric === "function") ric(callback);
  else setTimeout(callback, 200);
}

/**
 * One sweep of the backfill: snapshots the current queue, analyses it a few
 * files at a time on idle, and resolves once that snapshot is exhausted.
 * Files that arrive after the snapshot was taken are not picked up by this
 * call — `runBackfill` below is what re-runs this when that matters.
 */
function runBackfillSweep(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  return findUnanalysedAudioFileIds(LOUDNESS_ALGO_VERSION).then((ids) => {
    const queue = ids.filter((id) => !failedAnalysis.has(id));
    const total = queue.length;
    if (total === 0) {
      emitBackfillProgress(0, 0);
      onProgress?.(0, 0);
      return;
    }

    let done = 0;
    let remaining = queue;

    return new Promise((resolve) => {
      const step = () => {
        const batch = nextBackfillBatch(remaining, BACKFILL_BATCH_SIZE);
        if (batch.length === 0) {
          resolve();
          return;
        }
        remaining = remaining.slice(batch.length);

        void Promise.all(batch.map((id) => analyseAndStore(id)))
          .then(() => {
            done += batch.length;
            emitBackfillProgress(done, total);
            onProgress?.(done, total);
            onIdle(step);
          })
          .catch(() => {
            // A progress listener (emitBackfillProgress invokes every
            // subscriber synchronously) or onProgress itself threw. This
            // batch's files are already analysed and persisted regardless —
            // what matters is that `step` never gets scheduled again without
            // this: `resolve()` below would never run, this sweep's promise
            // would stay pending forever, and `backfillInFlight` would never
            // clear, so every future `runBackfill()` — including the
            // re-analyse button — would join a dead promise for the rest of
            // the session.
            resolve();
          });
      };

      onIdle(step);
    });
  });
}

/**
 * Analyses every file that needs it, a few at a time, on idle. Resolves
 * once nothing is left to do.
 *
 * Safely re-entrant by coalescing rather than superseding: the backfill
 * queue is global, so two callers — say, `ClientSideInitializer`'s
 * per-profile-activation sweep and a re-analyse button — genuinely want the
 * same work done, not a fight over which one gets to do it.
 *
 * - If no run is in flight, this starts one and returns its promise.
 * - If a run is already in flight, this returns that same promise and
 *   records that another run was requested.
 * - The queue is snapshotted at the start of each sweep, so a file that
 *   arrives mid-run would otherwise be missed. When the in-flight run
 *   finishes, if a re-run was requested while it was going, it does exactly
 *   one more sweep before resolving — not an open-ended loop, one.
 */
export function runBackfill(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();

  if (backfillInFlight) {
    backfillRerunRequested = true;
    return backfillInFlight;
  }

  const run = (async () => {
    do {
      backfillRerunRequested = false;
      await runBackfillSweep(onProgress);
    } while (backfillRerunRequested);
  })().finally(() => {
    backfillInFlight = null;
  });

  backfillInFlight = run;
  return run;
}

/**
 * The single entry point for bringing a profile's loudness state current:
 * warm the in-memory cache from what is already stored, run (or join) the
 * backfill for anything missing or stale, then warm the cache again to pick
 * up whatever that backfill just measured.
 *
 * Every caller that wants a profile's loudness current should call this
 * rather than assembling the three steps itself — `ClientSideInitializer` on
 * profile activation, `applySyncedProfile` after sync delivers new audio,
 * and the re-analyse action after clearing stale measurements. Safe to call
 * from more than one place because `runBackfill` coalesces; `loadProfileLoudness`
 * still assumes `profileId` is the currently active profile, since it
 * replaces the whole in-memory cache with that profile's entries.
 */
export async function refreshProfileLoudness(profileId: number): Promise<void> {
  await loadProfileLoudness(profileId);
  await runBackfill();
  await loadProfileLoudness(profileId);
}
