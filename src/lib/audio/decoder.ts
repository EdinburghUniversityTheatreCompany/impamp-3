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
 * Preloads audio files for a set of audio file IDs
 *
 * @param audioFileIds - Array of audio file IDs to preload
 * @returns Promise that resolves when all files have been attempted to load and decode
 */
export async function preloadAudioFiles(audioFileIds: number[]): Promise<void> {
  if (!audioFileIds || audioFileIds.length === 0) {
    return;
  }

  // Remove duplicates
  const uniqueIds = [...new Set(audioFileIds)];

  console.log(`[Audio Decoder] Preloading ${uniqueIds.length} audio files...`);
  const startTime = performance.now();

  // Create an array of promises for all loads, but catch errors for each individual load
  const preloadPromises = uniqueIds.map((id) =>
    loadAndDecodeAudio(id).catch((error) => {
      console.error(`[Audio Decoder] Error preloading ID ${id}:`, error);
      return null; // Return null on error so Promise.all doesn't fail
    }),
  );

  // Wait for all loads to complete (will never throw since we catch individual errors)
  await Promise.all(preloadPromises);

  const endTime = performance.now();
  const duration = endTime - startTime;
  console.log(
    `[Audio Decoder] Finished preloading ${uniqueIds.length} files in ${duration.toFixed(2)}ms`,
  );
}
