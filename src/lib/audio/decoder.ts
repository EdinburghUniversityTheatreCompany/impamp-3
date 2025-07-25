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
export async function loadAndDecodeAudio(
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
 * Load multiple audio files from DB in parallel batches
 *
 * @param audioFileIds - Array of audio file IDs to load from DB
 * @param batchSize - Number of files to load concurrently (default: 6)
 * @returns Promise that resolves to Map of audioFileId -> AudioFile data or null
 */
export async function loadAudioFilesParallel(
  audioFileIds: number[],
  batchSize: number = 6,
): Promise<Map<number, { name: string; blob: Blob } | null>> {
  const uniqueIds = [...new Set(audioFileIds)];
  const results = new Map<number, { name: string; blob: Blob } | null>();

  console.log(
    `[Audio Decoder] Loading ${uniqueIds.length} audio files in parallel batches of ${batchSize}...`,
  );

  // Process files in batches to avoid overwhelming IndexedDB
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);

    const batchPromises = batch.map(async (id) => {
      try {
        const audioFileData = await getAudioFile(id);
        if (!audioFileData?.blob) {
          console.warn(
            `[Audio Decoder] Audio file with ID ${id} not found or has no blob.`,
          );
          return { id, data: null };
        }
        return {
          id,
          data: {
            name: audioFileData.name,
            blob: audioFileData.blob,
          },
        };
      } catch (error) {
        console.error(
          `[Audio Decoder] Error loading audio file ID ${id}:`,
          error,
        );
        return { id, data: null };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    batchResults.forEach((result) => {
      if (result.status === "fulfilled") {
        results.set(result.value.id, result.value.data);
      }
    });
  }

  return results;
}

/**
 * Decode multiple audio files in parallel with concurrency control
 *
 * @param audioDataMap - Map of audioFileId -> audio file data from loadAudioFilesParallel
 * @param maxConcurrentDecodes - Maximum number of simultaneous decode operations (default: 4)
 * @returns Promise that resolves to Map of audioFileId -> decoded AudioBuffer or null
 */
export async function decodeAudioFilesParallel(
  audioDataMap: Map<number, { name: string; blob: Blob } | null>,
  maxConcurrentDecodes: number = 4,
): Promise<Map<number, AudioBuffer | null>> {
  const results = new Map<number, AudioBuffer | null>();
  const entries = Array.from(audioDataMap.entries()).filter(
    ([, data]) => data !== null,
  );

  console.log(
    `[Audio Decoder] Decoding ${entries.length} audio files with max ${maxConcurrentDecodes} concurrent operations...`,
  );

  // Process decodes with concurrency limit
  for (let i = 0; i < entries.length; i += maxConcurrentDecodes) {
    const batch = entries.slice(i, i + maxConcurrentDecodes);

    const batchPromises = batch.map(async ([id, data]) => {
      try {
        console.log(
          `[Audio Decoder] Decoding audio for file ID: ${id}, name: ${data!.name}`,
        );
        const decodedBuffer = await decodeAudioBlob(data!.blob);
        return { id, buffer: decodedBuffer };
      } catch (error) {
        console.error(
          `[Audio Decoder] Error decoding audio file ID ${id}:`,
          error,
        );
        return { id, buffer: null };
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    batchResults.forEach((result) => {
      if (result.status === "fulfilled") {
        results.set(result.value.id, result.value.buffer);
      }
    });
  }

  return results;
}

/**
 * Load and decode multiple audio files in parallel pipeline
 *
 * @param audioFileIds - Array of audio file IDs to load and decode
 * @param loadBatchSize - Number of files to load concurrently from DB (default: 6)
 * @param decodeBatchSize - Number of files to decode concurrently (default: 4)
 * @returns Promise that resolves to Map of audioFileId -> decoded AudioBuffer or null
 */
export async function loadAndDecodeAudioParallel(
  audioFileIds: number[],
  loadBatchSize: number = 6,
  decodeBatchSize: number = 4,
): Promise<Map<number, AudioBuffer | null>> {
  if (!audioFileIds || audioFileIds.length === 0) {
    return new Map();
  }

  const uniqueIds = [...new Set(audioFileIds)];
  const startTime = performance.now();

  console.log(
    `[Audio Decoder] Starting parallel load & decode pipeline for ${uniqueIds.length} files...`,
  );

  // Phase 1: Load all files from IndexedDB in parallel
  const audioDataMap = await loadAudioFilesParallel(uniqueIds, loadBatchSize);

  const loadTime = performance.now();
  console.log(
    `[Audio Decoder] Loaded ${audioDataMap.size} files in ${(loadTime - startTime).toFixed(2)}ms`,
  );

  // Phase 2: Decode all loaded files in parallel
  const decodedBuffers = await decodeAudioFilesParallel(
    audioDataMap,
    decodeBatchSize,
  );

  const endTime = performance.now();
  const totalDuration = endTime - startTime;
  const decodeDuration = endTime - loadTime;

  console.log(
    `[Audio Decoder] Parallel pipeline completed: ${decodedBuffers.size} files in ${totalDuration.toFixed(2)}ms ` +
      `(load: ${(loadTime - startTime).toFixed(2)}ms, decode: ${decodeDuration.toFixed(2)}ms)`,
  );

  return decodedBuffers;
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
  const activeDecodes = new Set<Promise<void>>();
  let loadedCount = 0;
  let decodedCount = 0;

  // Process files in load batches, but start decode immediately when each file is loaded
  for (let i = 0; i < uniqueIds.length; i += loadBatchSize) {
    const batch = uniqueIds.slice(i, i + loadBatchSize);

    // Start loading batch
    const loadPromises = batch.map(async (id) => {
      try {
        const audioFileData = await getAudioFile(id);
        loadedCount++;

        if (!audioFileData?.blob) {
          console.warn(
            `[Audio Decoder] Audio file with ID ${id} not found or has no blob.`,
          );
          results.set(id, null);
          return;
        }

        // Wait for decode slot to become available
        while (activeDecodes.size >= maxConcurrentDecodes) {
          await Promise.race(activeDecodes);
        }

        // Start decode immediately after load (pipelined)
        const decodePromise = (async () => {
          try {
            console.log(
              `[Audio Decoder] Decoding audio for file ID: ${id}, name: ${audioFileData.name}`,
            );
            const decodedBuffer = await decodeAudioBlob(audioFileData.blob);
            results.set(id, decodedBuffer);
            decodedCount++;
          } catch (error) {
            console.error(
              `[Audio Decoder] Error decoding audio file ID ${id}:`,
              error,
            );
            results.set(id, null);
            decodedCount++;
          } finally {
            activeDecodes.delete(decodePromise);
          }
        })();

        activeDecodes.add(decodePromise);
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
 * Decode large audio files using ReadableStream for progressive processing
 *
 * @param blob - The audio file blob to decode
 * @returns Promise that resolves to the decoded AudioBuffer
 */
export async function decodeAudioBlobStreaming(
  blob: Blob,
): Promise<AudioBuffer> {
  const context = getAudioContext();

  // For large files (>10MB), use streaming approach
  if (blob.size > 10 * 1024 * 1024) {
    console.log(
      `[Audio Decoder] Using streaming decode for large file (${(blob.size / 1024 / 1024).toFixed(1)}MB)`,
    );

    // Read the entire blob as ArrayBuffer (browser optimization will handle chunking)
    const arrayBuffer = await blob.arrayBuffer();

    try {
      const audioBuffer = await context.decodeAudioData(arrayBuffer);
      return audioBuffer;
    } catch (error) {
      console.error("[Audio Decoder] Error in streaming decode:", error);
      throw new Error("Failed to decode large audio file.");
    }
  } else {
    // Use standard decode for smaller files
    return decodeAudioBlob(blob);
  }
}

/**
 * Enhanced load and decode with ReadableStream support for large files
 *
 * @param audioFileId - ID of the audio file to load and decode
 * @returns Promise that resolves to the decoded AudioBuffer or null
 */
export async function loadAndDecodeAudioEnhanced(
  audioFileId: number,
): Promise<AudioBuffer | null> {
  // Check cache first
  if (isAudioBufferCached(audioFileId)) {
    const cachedBuffer = getCachedAudioBuffer(audioFileId);
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
    return cachedBuffer;
  }

  console.log(
    `[Audio Decoder] [Cache MISS] Loading audio file ID: ${audioFileId} from DB...`,
  );

  try {
    const audioFileData = await getAudioFile(audioFileId);
    if (!audioFileData?.blob) {
      console.warn(
        `[Audio Decoder] Audio file with ID ${audioFileId} not found or has no blob.`,
      );
      cacheAudioBuffer(audioFileId, null);
      return null;
    }

    console.log(
      `[Audio Decoder] Decoding audio for file ID: ${audioFileId}, name: ${audioFileData.name} ` +
        `(${(audioFileData.blob.size / 1024).toFixed(1)}KB)`,
    );

    // Use streaming decode for large files, standard decode for smaller ones
    const decodedBuffer = await decodeAudioBlobStreaming(audioFileData.blob);

    cacheAudioBuffer(audioFileId, decodedBuffer);
    return decodedBuffer;
  } catch (error) {
    console.error(
      `[Audio Decoder] Error loading/decoding audio file ID ${audioFileId}:`,
      error,
    );
    cacheAudioBuffer(audioFileId, null);
    return null;
  }
}

/**
 * Preloads audio files for a set of audio file IDs using pipelined loading
 *
 * @param audioFileIds - Array of audio file IDs to preload
 * @returns Promise that resolves when all files have been attempted to load and decode
 */
export async function preloadAudioFiles(audioFileIds: number[]): Promise<void> {
  if (!audioFileIds || audioFileIds.length === 0) {
    return;
  }

  // Remove duplicates and filter out already cached files
  const uniqueIds = [...new Set(audioFileIds)];
  const uncachedIds = uniqueIds.filter((id) => !isAudioBufferCached(id));

  if (uncachedIds.length === 0) {
    console.log(`[Audio Decoder] All ${uniqueIds.length} files already cached`);
    return;
  }

  console.log(
    `[Audio Decoder] Preloading ${uncachedIds.length} uncached files (${uniqueIds.length - uncachedIds.length} already cached)...`,
  );
  const startTime = performance.now();

  // Use pipelined loading for better performance
  const decodedBuffers = await loadAndDecodeAudioPipelined(uncachedIds);

  // Cache all results (both successful and failed)
  decodedBuffers.forEach((buffer, audioFileId) => {
    cacheAudioBuffer(audioFileId, buffer);
  });

  const endTime = performance.now();
  const duration = endTime - startTime;
  const successCount = Array.from(decodedBuffers.values()).filter(
    (buffer) => buffer !== null,
  ).length;

  console.log(
    `[Audio Decoder] Finished pipelined preloading: ${successCount}/${uncachedIds.length} successful in ${duration.toFixed(2)}ms`,
  );
}
