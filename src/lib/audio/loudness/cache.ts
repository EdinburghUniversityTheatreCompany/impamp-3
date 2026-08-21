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

const cacheListeners = new Set<() => void>();

function notifyCacheListeners(): void {
  for (const listener of cacheListeners) listener();
}

/**
 * Notifies when the cache contents change, so UI showing a measurement can
 * pick up an analysis that lands after it rendered.
 *
 * Analysis reaches the cache by two routes — the idle backfill and the
 * analyse-on-import path — and only this one is common to both. Backfill
 * progress covers just the former.
 */
export function subscribeToLoudnessCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}

export function setCachedLoudness(
  audioFileId: number,
  analysis: LoudnessAnalysis,
): void {
  cache.set(audioFileId, analysis);
  notifyCacheListeners();
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
  notifyCacheListeners();
}

/**
 * Forgets the analyses for ids whose rows have gone.
 *
 * The counterpart to `clearCachedAudioBuffer` for this map. The duplicate
 * collapse deletes audio rows, and an entry left under a deleted id is a
 * measurement of a recording nothing can name any more — harmless today,
 * because no reference to that id survives, but the map is otherwise only
 * ever emptied wholesale at profile activation.
 *
 * @returns How many entries were removed
 */
export function dropCachedLoudness(ids: Iterable<number>): number {
  let dropped = 0;
  for (const id of ids) {
    if (cache.delete(id)) dropped++;
  }
  if (dropped > 0) notifyCacheListeners();
  return dropped;
}

export function clearLoudnessCache(): void {
  cache.clear();
  notifyCacheListeners();
}

export function getLoudnessCacheSize(): number {
  return cache.size;
}
