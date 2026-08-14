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
 */
export async function loadProfileLoudness(profileId: number): Promise<void> {
  if (typeof window === "undefined") return;

  const ids = await getAudioFileIdsForProfile(profileId);
  const entries: [number, LoudnessAnalysis][] = [];

  for (const id of ids) {
    const file = await getAudioFile(id);
    if (file?.loudness && !shouldAnalyse(file.loudness)) {
      entries.push([id, file.loudness]);
    }
  }

  // warmLoudnessCache clears the map before repopulating it, so this always
  // fully replaces the previous profile's entries — there is no code path
  // where a stale entry can survive the switch.
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
 */
export async function runBackfill(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (typeof window === "undefined") return;

  const queue = await findUnanalysedAudioFileIds(LOUDNESS_ALGO_VERSION);
  const total = queue.length;
  if (total === 0) {
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

      void Promise.all(batch.map((id) => analyseAndStore(id))).then(() => {
        done += batch.length;
        onProgress?.(done, total);
        onIdle(step);
      });
    };

    onIdle(step);
  });
}
