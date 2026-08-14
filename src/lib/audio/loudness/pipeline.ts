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
  updateAudioFileLoudness,
} from "@/lib/db";
import type { LoudnessAnalysis } from "./types";
import { getCachedAudioBuffer } from "@/lib/audio/cache";
import { decodeAudioBlob } from "@/lib/audio/decoder";
import { analyseAudioBuffer } from "./analyse";
import { setCachedLoudness, warmLoudnessCache } from "./cache";
import { LOUDNESS_ALGO_VERSION } from "./constants";

/** How many files to analyse per idle slice. */
const BACKFILL_BATCH_SIZE = 3;

// Monotonic tokens so a superseded run can never write. A profile switch
// starts a new load and a new backfill; whichever run is no longer current
// must abandon its result rather than clobber the one that replaced it.
let loadGeneration = 0;
let backfillGeneration = 0;

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
 * `runBackfill` must have exactly one caller: a second caller takes a new
 * generation token, supersedes the first, and can leave the in-memory cache
 * repopulated from a snapshot taken before the surviving run's analyses
 * landed. UI that wants to display progress subscribes here instead.
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

    const analysis = analyseAudioBuffer(buffer);
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
 * gathering loop below awaits one `getAudioFile` per audio file, so a slow
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
  const entries: [number, LoudnessAnalysis][] = [];

  for (const id of ids) {
    const file = await getAudioFile(id);
    if (file?.loudness && !shouldAnalyse(file.loudness)) {
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
 * Analyses every file that needs it, a few at a time, on idle.
 * Resolves once the queue is empty.
 *
 * Guarded by the same generation-token pattern as `loadProfileLoudness`: a
 * profile switch bumps `backfillGeneration`, so the previous backfill's next
 * `step()` sees it is no longer current and resolves instead of continuing —
 * it stops decoding files for a profile the user has already left, rather
 * than racing the new backfill for the same idle slices.
 */
export async function runBackfill(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (typeof window === "undefined") return;

  const generation = ++backfillGeneration;
  const queue = (
    await findUnanalysedAudioFileIds(LOUDNESS_ALGO_VERSION)
  ).filter((id) => !failedAnalysis.has(id));
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
      if (generation !== backfillGeneration) {
        resolve(); // a newer backfill superseded this one
        return;
      }

      const batch = nextBackfillBatch(remaining, BACKFILL_BATCH_SIZE);
      if (batch.length === 0) {
        resolve();
        return;
      }
      remaining = remaining.slice(batch.length);

      void Promise.all(batch.map((id) => analyseAndStore(id))).then(() => {
        done += batch.length;
        emitBackfillProgress(done, total);
        onProgress?.(done, total);
        onIdle(step);
      });
    };

    onIdle(step);
  });
}
