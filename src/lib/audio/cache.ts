/**
 * Audio Module - Audio Buffer Cache
 *
 * Manages caching of decoded audio buffers with LRU eviction and memory management
 * to improve performance while preventing memory leaks and browser crashes.
 *
 * @module lib/audio/cache
 */

import { exposeE2EHook } from "../testHooks";

interface CacheEntry {
  buffer: AudioBuffer | null;
  lastAccessed: number;
  memorySize: number; // Estimated memory usage in bytes
}

// Base configuration constants
const BASE_MAX_CACHE_ENTRIES = 200; // Increased from 50 to 200 for better coverage
const BASE_MAX_MEMORY_MB = 500; // Increased from 100MB to 500MB for large setups
const CLEANUP_INTERVAL_MS = 30 * 1000; // Run cleanup every 30 seconds
const MEMORY_CHECK_THRESHOLD = 0.85; // Start cleanup at 85% (was 80%)

// Type extension for navigator.deviceMemory
interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

// Runtime cache configuration - determined on first access
let cacheConfig: {
  maxEntries: number;
  maxMemoryMB: number;
  maxMemoryBytes: number;
} | null = null;

/**
 * Get or initialize cache configuration based on client system memory
 * This runs on the client side, not during build
 */
function getCacheConfiguration(): {
  maxEntries: number;
  maxMemoryMB: number;
  maxMemoryBytes: number;
} {
  if (cacheConfig !== null) {
    return cacheConfig;
  }

  // Try to detect available system memory (Chrome/Edge only, client-side)
  const memoryInfo =
    typeof navigator !== "undefined" && "deviceMemory" in navigator
      ? (navigator as NavigatorWithMemory).deviceMemory
      : undefined;

  let maxEntries: number;
  let maxMemoryMB: number;

  if (typeof memoryInfo === "number") {
    // Adjust based on device memory (memoryInfo is in GB)
    if (memoryInfo >= 8) {
      // High-end devices: Allow up to 750MB and 300 entries
      maxEntries = 300;
      maxMemoryMB = 750;
    } else if (memoryInfo >= 4) {
      // Mid-range devices: Use base settings
      maxEntries = BASE_MAX_CACHE_ENTRIES;
      maxMemoryMB = BASE_MAX_MEMORY_MB;
    } else {
      // Lower-end devices: Be more conservative
      maxEntries = 100;
      maxMemoryMB = 250;
    }
  } else {
    // Fallback: Use base configuration if memory info unavailable
    maxEntries = BASE_MAX_CACHE_ENTRIES;
    maxMemoryMB = BASE_MAX_MEMORY_MB;
  }

  cacheConfig = {
    maxEntries,
    maxMemoryMB,
    maxMemoryBytes: maxMemoryMB * 1024 * 1024,
  };

  console.log(
    `[Audio Cache] Initialized with client-side limits: ${maxEntries} entries, ${maxMemoryMB}MB ` +
      `(client memory: ${memoryInfo ? memoryInfo + "GB" : "unknown"})`,
  );

  return cacheConfig;
}

// Internal LRU cache for decoded audio buffers
// Allows null for failed decodes to avoid repeated fetch attempts
const audioBufferCache = new Map<number, CacheEntry>();
let totalMemoryUsage = 0;
let cleanupIntervalId: number | null = null;

// Files that must survive LRU eviction, mapped to a reference count so that
// several holders (e.g. two armed pads sharing a sound) can pin the same file
// independently. Kept separate from the cache itself so a file can be pinned
// before its buffer has finished decoding.
const pinnedAudioFileIds = new Map<number, number>();

/**
 * Calculate estimated memory usage of an AudioBuffer
 */
function calculateBufferMemorySize(buffer: AudioBuffer | null): number {
  if (!buffer) return 100; // Small fixed size for failed decode markers
  // AudioBuffer memory = channels * sampleRate * duration * 4 bytes (float32)
  return buffer.numberOfChannels * buffer.sampleRate * buffer.duration * 4;
}

/**
 * Start the automatic cleanup interval
 */
function startCleanupInterval(): void {
  if (cleanupIntervalId !== null || typeof window === "undefined") return;

  cleanupIntervalId = window.setInterval(() => {
    const config = getCacheConfiguration();
    if (totalMemoryUsage > config.maxMemoryBytes * MEMORY_CHECK_THRESHOLD) {
      performCleanup("interval");
    }
  }, CLEANUP_INTERVAL_MS);
}

/**
 * Stop the automatic cleanup interval
 */
function stopCleanupInterval(): void {
  if (cleanupIntervalId !== null) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

/**
 * Perform LRU cleanup to reduce memory usage with improved strategy
 */
function performCleanup(trigger: "manual" | "interval" | "limit"): number {
  const initialSize = audioBufferCache.size;
  const initialMemory = totalMemoryUsage;
  const config = getCacheConfiguration();

  // Convert to array and sort by lastAccessed (oldest first)
  const entries = Array.from(audioBufferCache.entries()).sort(
    (a, b) => a[1].lastAccessed - b[1].lastAccessed,
  );

  let removedCount = 0;
  const now = Date.now();

  // Different cleanup strategies based on trigger
  let targetMemory: number;
  let targetEntries: number;

  if (trigger === "limit") {
    // Aggressive cleanup when hitting limits - make room for new entries
    targetMemory = config.maxMemoryBytes * 0.6; // Clean down to 60% capacity
    targetEntries = Math.floor(config.maxEntries * 0.7); // Clean down to 70% capacity
  } else {
    // Gentler cleanup for interval/manual
    targetMemory = config.maxMemoryBytes * 0.75; // Clean down to 75% capacity
    targetEntries = Math.floor(config.maxEntries * 0.85); // Clean down to 85% capacity
  }

  // Remove oldest entries, but prioritize failed decodes (null buffers) first
  const failedEntries = entries.filter(([, entry]) => entry.buffer === null);
  const successfulEntries = entries.filter(
    ([, entry]) => entry.buffer !== null,
  );

  // Remove all failed entries first (they take minimal memory anyway)
  for (const [id, entry] of failedEntries) {
    audioBufferCache.delete(id);
    totalMemoryUsage -= entry.memorySize;
    removedCount++;
  }

  // Then remove oldest successful entries if we still need to clean up
  let pinnedSkipped = 0;
  for (const [id, entry] of successfulEntries) {
    if (
      totalMemoryUsage <= targetMemory &&
      audioBufferCache.size <= targetEntries
    ) {
      break;
    }

    // Never evict a pinned buffer. Armed tracks pin their sounds so an
    // eviction can't turn a cued sound back into a slow load right before
    // the operator fires it.
    if (pinnedAudioFileIds.has(id)) {
      pinnedSkipped++;
      continue;
    }

    // Skip very recently accessed entries (within last 30 seconds) unless we're really over limit
    const ageMs = now - entry.lastAccessed;
    if (ageMs < 30 * 1000 && trigger !== "limit") {
      continue;
    }

    audioBufferCache.delete(id);
    totalMemoryUsage -= entry.memorySize;
    removedCount++;
  }

  console.log(
    `[Audio Cache] Cleanup (${trigger}): Removed ${removedCount}/${initialSize} entries ` +
      `(${failedEntries.length} failed, ${removedCount - failedEntries.length} successful, ` +
      `${pinnedSkipped} pinned kept), ` +
      `${(initialMemory / 1024 / 1024).toFixed(1)}MB → ${(totalMemoryUsage / 1024 / 1024).toFixed(1)}MB`,
  );

  // Pinned buffers can hold the cache above its target. That is intended,
  // but worth surfacing: it means armed tracks alone are near the memory cap.
  if (pinnedSkipped > 0 && totalMemoryUsage > targetMemory) {
    console.warn(
      `[Audio Cache] Cleanup could not reach its target: ${pinnedSkipped} pinned ` +
        `entries are holding ${(totalMemoryUsage / 1024 / 1024).toFixed(1)}MB in memory`,
    );
  }

  return removedCount;
}

/**
 * Retrieve a cached audio buffer by its ID and update LRU position
 *
 * @param audioFileId - ID of the audio file to retrieve from cache
 * @returns The cached audio buffer, null if decode failed, or undefined if not in cache
 */
export function getCachedAudioBuffer(
  audioFileId: number,
): AudioBuffer | null | undefined {
  const entry = audioBufferCache.get(audioFileId);
  if (entry) {
    // Update LRU position
    entry.lastAccessed = Date.now();
    return entry.buffer;
  }
  return undefined;
}

/**
 * Store an audio buffer in the cache with memory management
 *
 * @param audioFileId - ID of the audio file
 * @param buffer - The decoded audio buffer (or null if decode failed)
 */
export function cacheAudioBuffer(
  audioFileId: number,
  buffer: AudioBuffer | null,
): void {
  const memorySize = calculateBufferMemorySize(buffer);
  const now = Date.now();
  const config = getCacheConfiguration();

  // Remove existing entry if it exists to update memory tracking
  // (deleted immediately so a cleanup pass cannot subtract its size again)
  const existingEntry = audioBufferCache.get(audioFileId);
  if (existingEntry) {
    totalMemoryUsage -= existingEntry.memorySize;
    audioBufferCache.delete(audioFileId);
  }

  // Check if we need cleanup before adding new entry
  const potentialMemory = totalMemoryUsage + memorySize;
  const potentialEntries = audioBufferCache.size + 1;

  if (
    potentialMemory > config.maxMemoryBytes ||
    potentialEntries > config.maxEntries
  ) {
    performCleanup("limit");
  }

  // Add the new entry
  const entry: CacheEntry = {
    buffer,
    lastAccessed: now,
    memorySize,
  };

  audioBufferCache.set(audioFileId, entry);
  totalMemoryUsage += memorySize;

  // Start cleanup interval if this is the first entry
  if (audioBufferCache.size === 1) {
    startCleanupInterval();
  }

  console.log(
    `[Audio Cache] ${buffer ? "Stored" : "Marked as failed"} audio buffer for ID: ${audioFileId} ` +
      `(${(memorySize / 1024).toFixed(1)}KB, total: ${(totalMemoryUsage / 1024 / 1024).toFixed(1)}MB)`,
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
 * Pin an audio file so its cached buffer is never evicted by LRU cleanup
 *
 * Pins are reference counted: every `pinAudioBuffer` call must be matched by
 * an `unpinAudioBuffer` call. A file can be pinned before it is cached — the
 * pin then applies as soon as the decoded buffer arrives.
 *
 * @param audioFileId - ID of the audio file to protect from eviction
 */
export function pinAudioBuffer(audioFileId: number): void {
  const count = (pinnedAudioFileIds.get(audioFileId) ?? 0) + 1;
  pinnedAudioFileIds.set(audioFileId, count);

  if (count === 1) {
    console.log(`[Audio Cache] Pinned audio buffer for ID: ${audioFileId}`);
  }
}

/**
 * Release one pin on an audio file, making it evictable again once no
 * holders remain. Unpinning a file that was never pinned is a no-op.
 *
 * @param audioFileId - ID of the audio file to release
 */
export function unpinAudioBuffer(audioFileId: number): void {
  const count = pinnedAudioFileIds.get(audioFileId);
  if (count === undefined) return;

  if (count <= 1) {
    pinnedAudioFileIds.delete(audioFileId);
    console.log(`[Audio Cache] Unpinned audio buffer for ID: ${audioFileId}`);
  } else {
    pinnedAudioFileIds.set(audioFileId, count - 1);
  }
}

/**
 * Check whether an audio file is currently pinned against eviction
 *
 * @param audioFileId - ID of the audio file to check
 */
export function isAudioBufferPinned(audioFileId: number): boolean {
  return pinnedAudioFileIds.has(audioFileId);
}

/**
 * Release every pin at once. Holders normally unpin what they pinned; this is
 * the reset hatch, used to isolate tests from each other.
 * @internal
 */
export function clearAudioBufferPins(): void {
  const count = pinnedAudioFileIds.size;
  pinnedAudioFileIds.clear();

  if (count > 0) {
    console.log(`[Audio Cache] Released all ${count} audio buffer pins`);
  }
}

/**
 * Drop the decoded buffer for an audio file, leaving any pin in place.
 *
 * For invalidation, not deletion: the row is still there, its decoded form is
 * simply no longer worth keeping — a failed decode about to be retried is the
 * only caller today. A pin is a holder's claim on a *file*, deliberately
 * independent of whether that file happens to be decoded right now (see
 * `pinnedAudioFileIds`), so dropping it here would unprotect an armed cue
 * every time its first decode failed.
 *
 * @param audioFileId - ID of the audio file whose buffer should be re-decoded
 * @returns True if an entry was removed, false otherwise
 */
export function invalidateCachedAudioBuffer(audioFileId: number): boolean {
  const entry = audioBufferCache.get(audioFileId);
  const wasRemoved = audioBufferCache.delete(audioFileId);

  if (wasRemoved && entry) {
    totalMemoryUsage -= entry.memorySize;
    console.log(
      `[Audio Cache] Removed audio buffer for ID: ${audioFileId} ` +
        `(${(entry.memorySize / 1024).toFixed(1)}KB freed, total: ${(totalMemoryUsage / 1024 / 1024).toFixed(1)}MB)`,
    );

    // Stop cleanup interval if cache is empty
    if (audioBufferCache.size === 0) {
      stopCleanupInterval();
    }
  }

  return wasRemoved;
}

/**
 * Forget an audio file entirely: its decoded buffer *and* any pin on it.
 *
 * What every deletion path calls once the row is gone from IndexedDB — the
 * orphan sweep, the duplicate collapse and profile deletion. It used to delete
 * from the buffer map alone, which left a pin under an id nothing could name
 * any more: `isAudioBufferPinned` answered true for it forever, and no unpin
 * could ever arrive to collect it, because the holder's own release is keyed
 * by that same dead id.
 *
 * The pin goes wholesale rather than by one reference. A deleted row is not
 * one holder letting go; there is nothing left for any of them to hold. It
 * also goes whether or not a buffer was cached, because arming pins a file
 * immediately and its decode lands later — a row deleted in between leaves a
 * pin with no cache entry beside it, which is precisely the case an early
 * return on `wasRemoved` would skip.
 *
 * @param audioFileId - ID of the audio file that no longer exists
 * @returns True if a cache entry was removed, false otherwise
 */
export function clearCachedAudioBuffer(audioFileId: number): boolean {
  pinnedAudioFileIds.delete(audioFileId);
  return invalidateCachedAudioBuffer(audioFileId);
}

/**
 * Clear the entire audio buffer cache.
 *
 * Pins deliberately survive this. They are holders' claims on files, not
 * cache bookkeeping — a file can be pinned before it is ever decoded — and
 * emptying the buffer map deletes no rows, so every claim is still live and
 * still owed an `unpinAudioBuffer`. `clearAudioBufferPins` is the reset hatch
 * for the pins themselves.
 */
export function clearAudioCache(): void {
  const count = audioBufferCache.size;
  const memory = totalMemoryUsage;

  audioBufferCache.clear();
  totalMemoryUsage = 0;
  stopCleanupInterval();

  console.log(
    `[Audio Cache] Cleared entire cache (${count} entries, ${(memory / 1024 / 1024).toFixed(1)}MB freed)`,
  );
}

/**
 * Get information about the current cache state
 *
 * @returns Object with cache statistics including memory usage
 */
export function getAudioCacheStats(): {
  totalEntries: number;
  successfulDecodes: number;
  failedDecodes: number;
  pinnedEntries: number;
  memoryUsageMB: number;
  memoryUsagePercent: number;
  maxMemoryMB: number;
  oldestEntryAge: number;
  newestEntryAge: number;
} {
  let successfulDecodes = 0;
  let failedDecodes = 0;
  let pinnedEntries = 0;
  let oldestAccess = Infinity;
  let newestAccess = 0;
  const now = Date.now();

  audioBufferCache.forEach((entry, audioFileId) => {
    if (entry.buffer === null) {
      failedDecodes++;
    } else {
      successfulDecodes++;
    }

    if (pinnedAudioFileIds.has(audioFileId)) {
      pinnedEntries++;
    }

    oldestAccess = Math.min(oldestAccess, entry.lastAccessed);
    newestAccess = Math.max(newestAccess, entry.lastAccessed);
  });

  const config = getCacheConfiguration();

  return {
    totalEntries: audioBufferCache.size,
    successfulDecodes,
    failedDecodes,
    pinnedEntries,
    memoryUsageMB: Number((totalMemoryUsage / 1024 / 1024).toFixed(2)),
    memoryUsagePercent: Number(
      ((totalMemoryUsage / config.maxMemoryBytes) * 100).toFixed(1),
    ),
    maxMemoryMB: config.maxMemoryMB,
    oldestEntryAge:
      oldestAccess === Infinity ? 0 : Math.floor((now - oldestAccess) / 1000),
    newestEntryAge:
      newestAccess === 0 ? 0 : Math.floor((now - newestAccess) / 1000),
  };
}

// Which sounds are decoded and which are pinned against eviction is invisible
// in the UI, so the armed-track tests read it through this hook. See
// lib/testHooks.
exposeE2EHook("__impampAudioCache", () => ({
  cachedIds: Array.from(audioBufferCache.keys()),
  pinnedIds: Array.from(pinnedAudioFileIds.keys()),
}));

/**
 * Reset cache configuration for testing purposes
 * @internal
 */
export function resetCacheConfiguration(): void {
  cacheConfig = null;
}
