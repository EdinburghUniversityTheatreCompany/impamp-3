/**
 * Audio Module - Audio Decoder
 *
 * Handles decoding of audio data from blobs into AudioBuffer objects.
 * Provides functions to load and decode audio files from IndexedDB.
 *
 * @module lib/audio/decoder
 */

import { getAudioFile } from "../db";
import { getAudioContext } from "./context";
import {
  getCachedAudioBuffer,
  cacheAudioBuffer,
  isAudioBufferCached,
} from "./cache";

// Loads/decodes that are currently running, keyed by audio file ID.
// Lets concurrent callers (e.g. a preload and a live trigger) share one decode.
const inFlightLoads = new Map<number, Promise<AudioBuffer | null>>();

/**
 * Registers a load/decode operation as in-flight for the given audio file ID
 *
 * @param audioFileId - ID of the audio file being loaded
 * @param run - The operation to run and share with concurrent callers
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
function trackInFlightLoad(
  audioFileId: number,
  run: () => Promise<AudioBuffer | null>,
): Promise<AudioBuffer | null> {
  const promise = run().finally(() => {
    if (inFlightLoads.get(audioFileId) === promise) {
      inFlightLoads.delete(audioFileId);
    }
  });

  inFlightLoads.set(audioFileId, promise);
  return promise;
}

/**
 * Waits on an already running load for the same audio file, reporting the
 * outcome through this caller's loading state callback
 *
 * @param audioFileId - ID of the audio file being loaded
 * @param inFlight - The pending load to join
 * @param startTime - Start time of this caller's request
 * @param onStateChange - Optional callback for loading state updates
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
async function joinInFlightLoad(
  audioFileId: number,
  inFlight: Promise<AudioBuffer | null>,
  startTime: number,
  onStateChange?: LoadingStateCallback,
): Promise<AudioBuffer | null> {
  console.log(
    `[Audio Decoder] [In-flight] Joining pending load for ID: ${audioFileId}`,
  );

  const buffer = await inFlight;

  onStateChange?.({
    audioFileId,
    status: buffer ? "ready" : "error",
    progress: 1,
    error: buffer ? undefined : "Failed to load audio",
    startTime,
  });

  return buffer;
}

/**
 * Decode audio data from a Blob
 *
 * @param blob - The audio file blob to decode
 * @returns Promise that resolves to the decoded AudioBuffer
 * @throws Error if decoding fails
 */
export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const context = getAudioContext();
  const arrayBuffer = await blob.arrayBuffer();

  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } catch (error) {
    console.error("[Audio Decoder] Error decoding audio data:", error);
    throw new Error("Failed to decode audio data.");
  }
}

/**
 * Load audio file from DB and decode it, using the audio buffer cache
 *
 * @param audioFileId - ID of the audio file to load and decode
 * @returns Promise that resolves to the decoded AudioBuffer or null if file not found or decode failed
 */
export function loadAndDecodeAudio(
  audioFileId: number,
): Promise<AudioBuffer | null> {
  const inFlight = inFlightLoads.get(audioFileId);
  if (inFlight) {
    console.log(
      `[Audio Decoder] [In-flight] Joining pending load for ID: ${audioFileId}`,
    );
    return inFlight;
  }

  return trackInFlightLoad(audioFileId, () =>
    loadAndDecodeAudioUnshared(audioFileId),
  );
}

/**
 * Load and decode implementation without in-flight sharing
 *
 * @param audioFileId - ID of the audio file to load and decode
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
async function loadAndDecodeAudioUnshared(
  audioFileId: number,
): Promise<AudioBuffer | null> {
  // 1. Check cache first
  if (isAudioBufferCached(audioFileId)) {
    const cachedBuffer = getCachedAudioBuffer(audioFileId);
    // Handle undefined (should never happen if isAudioBufferCached is true)
    if (cachedBuffer === undefined) {
      console.warn(
        `[Audio Decoder] Unexpected undefined buffer for cached ID: ${audioFileId}`,
      );
      return null;
    }

    const cacheStatus = cachedBuffer ? "HIT" : "HIT (Failed)";
    console.log(
      `[Audio Decoder] [Cache ${cacheStatus}] Audio buffer for file ID: ${audioFileId}`,
    );
    return cachedBuffer; // Return cached buffer or null
  }

  // 2. If not in cache, load from DB
  console.log(
    `[Audio Decoder] [Cache MISS] Loading audio file ID: ${audioFileId} from DB...`,
  );
  try {
    const audioFileData = await getAudioFile(audioFileId);
    if (!audioFileData?.blob) {
      console.warn(
        `[Audio Decoder] Audio file with ID ${audioFileId} not found or has no blob.`,
      );
      cacheAudioBuffer(audioFileId, null); // Cache the failure (not found)
      return null;
    }

    // 3. Decode the audio
    console.log(
      `[Audio Decoder] Decoding audio for file ID: ${audioFileId}, name: ${audioFileData.name}`,
    );
    const decodedBuffer = await decodeAudioBlob(audioFileData.blob);

    // 4. Cache the result
    cacheAudioBuffer(audioFileId, decodedBuffer);
    return decodedBuffer;
  } catch (error) {
    console.error(
      `[Audio Decoder] Error loading/decoding audio file ID ${audioFileId}:`,
      error,
    );
    cacheAudioBuffer(audioFileId, null); // Cache the failure (decode error)
    return null; // Return null on error
  }
}

/**
 * Load and decode audio files with pipelined processing - starts decoding as soon as files are loaded
 *
 * @param audioFileIds - Array of audio file IDs to load and decode
 * @param loadBatchSize - Number of files to load concurrently from DB (default: 6)
 * @param maxConcurrentDecodes - Maximum number of simultaneous decode operations (default: 4)
 * @returns Promise that resolves to Map of audioFileId -> decoded AudioBuffer or null
 */
export async function loadAndDecodeAudioPipelined(
  audioFileIds: number[],
  loadBatchSize: number = 6,
  maxConcurrentDecodes: number = 4,
): Promise<Map<number, AudioBuffer | null>> {
  if (!audioFileIds || audioFileIds.length === 0) {
    return new Map();
  }

  const uniqueIds = [...new Set(audioFileIds)];
  const startTime = performance.now();
  const results = new Map<number, AudioBuffer | null>();

  console.log(
    `[Audio Decoder] Starting pipelined load & decode for ${uniqueIds.length} files...`,
  );

  // Track ongoing decode operations
  const activeDecodes = new Set<Promise<AudioBuffer | null>>();
  let loadedCount = 0;
  let decodedCount = 0;

  // Process files in load batches, but start decode immediately when each file is loaded
  for (let i = 0; i < uniqueIds.length; i += loadBatchSize) {
    const batch = uniqueIds.slice(i, i + loadBatchSize);

    // Start loading batch
    const loadPromises = batch.map(async (id) => {
      try {
        // Reuse a load that is already running for this file
        const inFlight = inFlightLoads.get(id);
        if (inFlight) {
          console.log(
            `[Audio Decoder] [In-flight] Joining pending load for ID: ${id}`,
          );
          results.set(id, await inFlight);
          loadedCount++;
          decodedCount++;
          return;
        }

        // Registered before the first await, not after.
        //
        // This used to read the record and then wait for a decode slot before
        // publishing anything, so between the check above and the entry
        // appearing there were two awaits in which a concurrent trigger for
        // the same pad found nothing in flight and started its own read and
        // decode of the same blob. Decoding is the expensive part, and the
        // preloader and a keypress race for exactly the same file by design.
        const work = trackInFlightLoad(id, async () => {
          const audioFileData = await getAudioFile(id);
          loadedCount++;

          if (!audioFileData?.blob) {
            console.warn(
              `[Audio Decoder] Audio file with ID ${id} not found or has no blob.`,
            );
            results.set(id, null);
            return null;
          }

          // Wait for a decode slot. Holding the in-flight entry across this is
          // the point: a joiner waits for our decode instead of starting one.
          while (activeDecodes.size >= maxConcurrentDecodes) {
            await Promise.race(activeDecodes);
          }

          try {
            console.log(
              `[Audio Decoder] Decoding audio for file ID: ${id}, name: ${audioFileData.name}`,
            );
            const decodedBuffer = await decodeAudioBlob(audioFileData.blob);
            results.set(id, decodedBuffer);
            decodedCount++;
            return decodedBuffer;
          } catch (error) {
            console.error(
              `[Audio Decoder] Error decoding audio file ID ${id}:`,
              error,
            );
            results.set(id, null);
            decodedCount++;
            return null;
          }
        });

        activeDecodes.add(work);
        // `.catch` as well as `.finally`: this branch is not awaited, so a
        // rejection here would surface as an unhandled rejection even though
        // the `await` below handles it.
        void work
          .catch(() => undefined)
          .finally(() => {
            activeDecodes.delete(work);
          });

        // Awaited, so a batch completes before the next one starts. Slightly
        // less overlap than letting the next batch's reads run against this
        // batch's decodes, which is what the old shape bought — and what it
        // paid for that with was the window above. Concurrency is still capped
        // by `maxConcurrentDecodes` either way.
        await work;
      } catch (error) {
        console.error(
          `[Audio Decoder] Error loading audio file ID ${id}:`,
          error,
        );
        results.set(id, null);
        loadedCount++;
      }
    });

    // Wait for this batch of loads to complete before starting next batch
    await Promise.allSettled(loadPromises);
  }

  // Wait for all remaining decode operations to complete
  await Promise.allSettled(activeDecodes);

  const endTime = performance.now();
  const totalDuration = endTime - startTime;
  const successCount = Array.from(results.values()).filter(
    (buffer) => buffer !== null,
  ).length;

  console.log(
    `[Audio Decoder] Pipelined processing completed: ${successCount}/${uniqueIds.length} successful in ${totalDuration.toFixed(2)}ms ` +
      `(loaded: ${loadedCount}, decoded: ${decodedCount})`,
  );

  return results;
}

/**
 * Loading states for instant response feedback
 */
export interface LoadingState {
  audioFileId: number;
  status: "loading" | "decoding" | "ready" | "error";
  progress?: number; // 0-1 for progress indication
  error?: string;
  startTime: number;
}

/**
 * Callback for loading state updates
 */
export type LoadingStateCallback = (state: LoadingState) => void;

/**
 * Fetches an audio file's blob from IndexedDB, reporting an "error" state and
 * caching the miss if it's not found or has no blob.
 */
async function getAudioFileBlobOrFail(
  audioFileId: number,
  startTime: number,
  onStateChange?: LoadingStateCallback,
) {
  const audioFileData = await getAudioFile(audioFileId);
  if (!audioFileData?.blob) {
    console.warn(
      `[Audio Decoder] Audio file with ID ${audioFileId} not found or has no blob.`,
    );
    cacheAudioBuffer(audioFileId, null);

    onStateChange?.({
      audioFileId,
      status: "error",
      error: "Audio file not found or has no data",
      startTime,
    });

    return null;
  }
  return audioFileData;
}

/**
 * Enhanced load and decode with instant response and progress feedback
 *
 * @param audioFileId - ID of the audio file to load and decode
 * @param onStateChange - Optional callback for loading state updates
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
export async function loadAndDecodeAudioEnhanced(
  audioFileId: number,
  onStateChange?: LoadingStateCallback,
): Promise<AudioBuffer | null> {
  const startTime = performance.now();

  // Immediate callback with loading state
  console.log(
    `[Audio Decoder] [Enhanced] Starting load for ID: ${audioFileId}`,
  );
  onStateChange?.({
    audioFileId,
    status: "loading",
    progress: 0,
    startTime,
  });

  // Check cache first
  if (isAudioBufferCached(audioFileId)) {
    console.log(`[Audio Decoder] [Enhanced] Cache HIT for ID: ${audioFileId}`);
    const cachedBuffer = getCachedAudioBuffer(audioFileId);
    if (cachedBuffer === undefined) {
      console.warn(
        `[Audio Decoder] Unexpected undefined buffer for cached ID: ${audioFileId}`,
      );
      onStateChange?.({
        audioFileId,
        status: "error",
        error: "Unexpected cache state",
        startTime,
      });
      return null;
    }
    const cacheStatus = cachedBuffer ? "HIT" : "HIT (Failed)";
    console.log(
      `[Audio Decoder] [Cache ${cacheStatus}] Audio buffer for file ID: ${audioFileId}`,
    );

    onStateChange?.({
      audioFileId,
      status: cachedBuffer ? "ready" : "error",
      progress: 1,
      error: cachedBuffer ? undefined : "Previously failed to decode",
      startTime,
    });

    return cachedBuffer;
  }

  // Share a load that is already running for this file
  const inFlight = inFlightLoads.get(audioFileId);
  if (inFlight) {
    return joinInFlightLoad(audioFileId, inFlight, startTime, onStateChange);
  }

  console.log(
    `[Audio Decoder] [Cache MISS] Loading audio file ID: ${audioFileId} from DB...`,
  );

  return trackInFlightLoad(audioFileId, () =>
    loadAndDecodeUnshared(audioFileId, startTime, onStateChange),
  );
}

/**
 * Enhanced load and decode implementation without in-flight sharing
 *
 * @param audioFileId - ID of the audio file to load and decode
 * The one load-and-decode body.
 *
 * The "enhanced" and "instant" paths each had their own copy, differing only
 * in log prefixes and a progress number. That was invisible while they called
 * two different decoders — until those turned out to be the same decoder with
 * extra ceremony, at which point the two bodies were plainly one.
 *
 * @param audioFileId - The audio file to load
 * @param startTime - Start time used for loading state reporting
 * @param onStateChange - Optional callback for loading state updates
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
async function loadAndDecodeUnshared(
  audioFileId: number,
  startTime: number,
  onStateChange?: LoadingStateCallback,
): Promise<AudioBuffer | null> {
  try {
    // Update state: loading from IndexedDB
    onStateChange?.({
      audioFileId,
      status: "loading",
      progress: 0.1,
      startTime,
    });

    const audioFileData = await getAudioFileBlobOrFail(
      audioFileId,
      startTime,
      onStateChange,
    );
    if (!audioFileData) {
      return null;
    }

    // Update state: file loaded, starting decode
    onStateChange?.({
      audioFileId,
      status: "decoding",
      progress: 0.3,
      startTime,
    });

    console.log(
      `[Audio Decoder] Decoding audio for file ID: ${audioFileId}, name: ${audioFileData.name} ` +
        `(${(audioFileData.blob.size / 1024).toFixed(1)}KB)`,
    );

    // `decodeAudioBlobStreaming` used to be called here. It branched on a
    // 10 MB threshold and then did `blob.arrayBuffer()` + `decodeAudioData`
    // either way — which is exactly `decodeAudioBlob` — so the branch bought a
    // different error message and nothing else. Nothing about it streamed.
    const decodedBuffer = await decodeAudioBlob(audioFileData.blob);

    // Update state: decode complete
    onStateChange?.({
      audioFileId,
      status: "ready",
      progress: 1,
      startTime,
    });

    cacheAudioBuffer(audioFileId, decodedBuffer);
    return decodedBuffer;
  } catch (error) {
    console.error(
      `[Audio Decoder] Error loading/decoding audio file ID ${audioFileId}:`,
      error,
    );
    cacheAudioBuffer(audioFileId, null);

    onStateChange?.({
      audioFileId,
      status: "error",
      error:
        error instanceof Error
          ? error.message
          : "Unknown error during loading/decoding",
      startTime,
    });

    return null;
  }
}

/**
 * Load and decode with instant fallback - provides immediate response even on cache miss
 *
 * @param audioFileId - ID of the audio file to load and decode
 * @param onStateChange - Optional callback for loading state updates
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
export async function loadAndDecodeAudioInstant(
  audioFileId: number,
  onStateChange?: LoadingStateCallback,
): Promise<AudioBuffer | null> {
  const startTime = performance.now();

  // Provide instant feedback
  console.log(
    `[Audio Decoder] [Instant] Starting instant load for ID: ${audioFileId}`,
  );
  onStateChange?.({
    audioFileId,
    status: "loading",
    progress: 0,
    startTime,
  });

  // Check cache first - if hit, return immediately
  if (isAudioBufferCached(audioFileId)) {
    console.log(
      `[Audio Decoder] [Instant] Cache HIT for ID: ${audioFileId} - no spinner needed`,
    );
    return loadAndDecodeAudioEnhanced(audioFileId, onStateChange);
  }

  // Share a load that is already running for this file
  const inFlight = inFlightLoads.get(audioFileId);
  if (inFlight) {
    return joinInFlightLoad(audioFileId, inFlight, startTime, onStateChange);
  }

  // For cache misses, start loading in background while providing immediate user feedback
  console.log(
    `[Audio Decoder] [Instant Response] Starting background load for ID: ${audioFileId}`,
  );

  return trackInFlightLoad(audioFileId, () =>
    loadAndDecodeUnshared(audioFileId, startTime, onStateChange),
  );
}
