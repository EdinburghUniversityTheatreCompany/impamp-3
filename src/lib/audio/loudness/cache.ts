/**
 * Audio Module - Loudness cache
 *
 * Holds the analysis for the active profile in memory so gain resolution at
 * trigger time is synchronous. Awaiting a database read before playback would
 * add jitter to a live-performance tool, which is not acceptable here.
 *
 * Small enough not to need eviction: ~80 bytes per second of audio, so a
 * 30-minute board is about 150 KB.
 *
 * @module lib/audio/loudness/cache
 */

import type { LoudnessAnalysis } from "./types";

const cache = new Map<number, LoudnessAnalysis>();

export function setCachedLoudness(
  audioFileId: number,
  analysis: LoudnessAnalysis,
): void {
  cache.set(audioFileId, analysis);
}

export function getCachedLoudness(
  audioFileId: number,
): LoudnessAnalysis | undefined {
  return cache.get(audioFileId);
}

/** Replaces the entire cache — used when switching profile. */
export function warmLoudnessCache(
  entries: Iterable<[number, LoudnessAnalysis]>,
): void {
  cache.clear();
  for (const [id, analysis] of entries) cache.set(id, analysis);
}

export function clearLoudnessCache(): void {
  cache.clear();
}

export function getLoudnessCacheSize(): number {
  return cache.size;
}
