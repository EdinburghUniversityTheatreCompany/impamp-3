/**
 * Audio Module - Audio Buffer Cache
 *
 * Manages caching of decoded audio buffers to improve performance
 * and reduce redundant decoding of the same audio files.
 *
 * @module lib/audio/cache
 */

// Internal cache for decoded audio buffers
// Allows null for failed decodes to avoid repeated fetch attempts
const audioBufferCache = new Map<number, AudioBuffer | null>();

/**
 * Retrieve a cached audio buffer by its ID
 *
 * @param audioFileId - ID of the audio file to retrieve from cache
 * @returns The cached audio buffer, null if decode failed, or undefined if not in cache
 */
export function getCachedAudioBuffer(
  audioFileId: number,
): AudioBuffer | null | undefined {
  return audioBufferCache.get(audioFileId);
}

/**
 * Store an audio buffer in the cache
 *
 * @param audioFileId - ID of the audio file
 * @param buffer - The decoded audio buffer (or null if decode failed)
 */
export function cacheAudioBuffer(
  audioFileId: number,
  buffer: AudioBuffer | null,
): void {
  audioBufferCache.set(audioFileId, buffer);
  console.log(
    `[Audio Cache] ${buffer ? "Stored" : "Marked as failed"} audio buffer for ID: ${audioFileId}`,
  );
}

/**
 * Check if an audio buffer is already in the cache
 *
 * @param audioFileId - ID of the audio file to check
 * @returns True if the audio file is in the cache (even if null)
 */
export function isAudioBufferCached(audioFileId: number): boolean {
  return audioBufferCache.has(audioFileId);
}

/**
 * Clear a specific audio buffer from the cache
 *
 * @param audioFileId - ID of the audio file to remove from cache
 * @returns True if an entry was removed, false otherwise
 */
export function clearCachedAudioBuffer(audioFileId: number): boolean {
  const wasRemoved = audioBufferCache.delete(audioFileId);
  if (wasRemoved) {
    console.log(`[Audio Cache] Removed audio buffer for ID: ${audioFileId}`);
  }
  return wasRemoved;
}

/**
 * Clear the entire audio buffer cache
 */
export function clearAudioCache(): void {
  const count = audioBufferCache.size;
  audioBufferCache.clear();
  console.log(`[Audio Cache] Cleared entire cache (${count} entries)`);
}

/**
 * Get information about the current cache state
 *
 * @returns Object with cache statistics
 */
export function getAudioCacheStats(): {
  totalEntries: number;
  successfulDecodes: number;
  failedDecodes: number;
} {
  let successfulDecodes = 0;
  let failedDecodes = 0;

  audioBufferCache.forEach((buffer) => {
    if (buffer === null) {
      failedDecodes++;
    } else {
      successfulDecodes++;
    }
  });

  return {
    totalEntries: audioBufferCache.size,
    successfulDecodes,
    failedDecodes,
  };
}
