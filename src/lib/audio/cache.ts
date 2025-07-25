/**
 * Audio Module - Audio Buffer Cache
 *
 * Manages caching of decoded audio buffers with LRU eviction and memory management
 * to improve performance while preventing memory leaks and browser crashes.
 *
 * @module lib/audio/cache
 */

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
  for (const [id, entry] of successfulEntries) {
    if (
      totalMemoryUsage <= targetMemory &&
      audioBufferCache.size <= targetEntries
    ) {
      break;
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
      `(${failedEntries.length} failed, ${removedCount - failedEntries.length} successful), ` +
      `${(initialMemory / 1024 / 1024).toFixed(1)}MB → ${(totalMemoryUsage / 1024 / 1024).toFixed(1)}MB`,
  );

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
  const existingEntry = audioBufferCache.get(audioFileId);
  if (existingEntry) {
    totalMemoryUsage -= existingEntry.memorySize;
  }

  // Check if we need cleanup before adding new entry
  const potentialMemory = totalMemoryUsage + memorySize;
  const potentialEntries = audioBufferCache.size + (existingEntry ? 0 : 1);

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
 * Clear a specific audio buffer from the cache
 *
 * @param audioFileId - ID of the audio file to remove from cache
 * @returns True if an entry was removed, false otherwise
 */
export function clearCachedAudioBuffer(audioFileId: number): boolean {
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
 * Clear the entire audio buffer cache
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
  memoryUsageMB: number;
  memoryUsagePercent: number;
  maxMemoryMB: number;
  oldestEntryAge: number;
  newestEntryAge: number;
} {
  let successfulDecodes = 0;
  let failedDecodes = 0;
  let oldestAccess = Infinity;
  let newestAccess = 0;
  const now = Date.now();

  audioBufferCache.forEach((entry) => {
    if (entry.buffer === null) {
      failedDecodes++;
    } else {
      successfulDecodes++;
    }

    oldestAccess = Math.min(oldestAccess, entry.lastAccessed);
    newestAccess = Math.max(newestAccess, entry.lastAccessed);
  });

  const config = getCacheConfiguration();

  return {
    totalEntries: audioBufferCache.size,
    successfulDecodes,
    failedDecodes,
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

/**
 * Force a manual cleanup of the cache
 * Useful for debugging or when memory pressure is detected externally
 *
 * @returns Number of entries removed
 */
export function forceCleanup(): number {
  return performCleanup("manual");
}

/**
 * Reset cache configuration for testing purposes
 * @internal
 */
export function resetCacheConfiguration(): void {
  cacheConfig = null;
}

/**
 * Get current cache configuration including dynamic adjustments
 */
export function getCacheConfig(): {
  maxEntries: number;
  maxMemoryMB: number;
  cleanupIntervalMs: number;
  memoryThreshold: number;
  baseMaxEntries: number;
  baseMaxMemoryMB: number;
  systemMemoryGB: number | null;
  isDynamicallyAdjusted: boolean;
} {
  const config = getCacheConfiguration();
  const systemMemory =
    typeof navigator !== "undefined" && "deviceMemory" in navigator
      ? (navigator as NavigatorWithMemory).deviceMemory || null
      : null;
  const isDynamic = systemMemory !== null;

  return {
    maxEntries: config.maxEntries,
    maxMemoryMB: config.maxMemoryMB,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    memoryThreshold: MEMORY_CHECK_THRESHOLD,
    baseMaxEntries: BASE_MAX_CACHE_ENTRIES,
    baseMaxMemoryMB: BASE_MAX_MEMORY_MB,
    systemMemoryGB: systemMemory,
    isDynamicallyAdjusted: isDynamic,
  };
}
