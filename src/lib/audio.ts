import { getAudioFile } from "./db";
import { playbackStoreActions } from "@/store/playbackStore"; // Import store actions
import type { PlaybackState } from "@/store/playbackStore"; // Import the state type

// Detect client-side environment
const isClient = typeof window !== "undefined";

// rAF loop ID
let rAFId: number | null = null;

// --- rAF Playback Loop ---

function playbackLoopTick() {
  if (!audioContext || activeTracks.size === 0) {
    stopPlaybackLoop(); // Stop if context lost or no tracks
    return;
  }

  const currentTime = audioContext.currentTime;
  const currentPlaybackState = new Map<string, PlaybackState>();

  activeTracks.forEach((track, key) => {
    const elapsed = currentTime - track.startTime;
    const remaining = Math.max(0, track.duration - elapsed);
    const progress = Math.min(1, elapsed / track.duration);

    // If remaining time is effectively zero and it's not already fading,
    // treat it as ended (handles cases where onended might be delayed)
    if (remaining <= 0 && !track.isFading) {
      // This track should be removed, but let onended handle the primary cleanup.
      // We'll just exclude it from the state update for this tick.
      // Alternatively, could trigger removal here, but might conflict with onended.
      // Let's rely on onended/stop/fadeout for removal for now.
      return; // Skip adding to current state if naturally ended
    }

    currentPlaybackState.set(key, {
      key,
      name: track.name,
      remainingTime: remaining,
      totalDuration: track.duration,
      progress: progress,
      isFading: track.isFading,
      padInfo: track.padInfo,
    });
  });

  // Update the Zustand store with the latest state
  if (currentPlaybackState.size > 0) {
    playbackStoreActions.setPlaybackState(currentPlaybackState);
    // Schedule the next frame
    rAFId = requestAnimationFrame(playbackLoopTick);
  } else {
    // If the loop ran but resulted in no tracks needing state updates, stop the loop.
    stopPlaybackLoop();
  }
}

function startPlaybackLoop() {
  if (rAFId === null && activeTracks.size > 0 && isClient) {
    console.log("[Audio] Starting playback loop...");
    rAFId = requestAnimationFrame(playbackLoopTick);
  }
}

function stopPlaybackLoop() {
  if (rAFId !== null) {
    console.log("[Audio] Stopping playback loop.");
    cancelAnimationFrame(rAFId);
    rAFId = null;
    // Optionally clear the store state when the loop stops entirely
    // playbackStoreActions.clearAllTracks(); // Consider if this is desired behavior
  }
}

// Define interface for active track information
export interface ActiveTrack {
  source: AudioBufferSourceNode;
  name: string;
  startTime: number;
  duration: number;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
  isFading: boolean; // Added for integrated fade state
}

let audioContext: AudioContext | null = null;
const activeTracks: Map<string, ActiveTrack> = new Map(); // Enhanced tracking with metadata
// const fadingTracks: Map<string, boolean> = new Map(); // REMOVED - Integrated into ActiveTrack

// Internal cache for decoded audio buffers
const audioBufferCache = new Map<number, AudioBuffer | null>(); // Allow null for failed decodes

// Define an interface for window with potential webkitAudioContext
interface ExtendedWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

// Initialize AudioContext lazily on first interaction
function getAudioContext(): AudioContext {
  // Ensure we only run this on the client side
  if (!isClient) {
    throw new Error("AudioContext is not available on the server");
  }

  if (!audioContext) {
    // Cast window to the extended type to check for webkitAudioContext
    const extendedWindow = window as ExtendedWindow;
    audioContext = new (window.AudioContext ||
      extendedWindow.webkitAudioContext)();
    // Resume context if it was suspended (e.g., due to browser policy)
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  }
  return audioContext;
}

// Decode audio data from a Blob
async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const context = getAudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } catch (error) {
    console.error("Error decoding audio data:", error);
    throw new Error("Failed to decode audio data.");
  }
}

// Load audio file from DB and decode it, using an internal cache
export async function loadAndDecodeAudio(
  audioFileId: number,
): Promise<AudioBuffer | null> {
  // 1. Check cache first
  if (audioBufferCache.has(audioFileId)) {
    // Explicitly get and check the value to satisfy TS
    const cachedValue = audioBufferCache.get(audioFileId);
    if (cachedValue !== undefined) {
      // Check if the key truly exists with a value (even if null)
      console.log(
        `[Cache ${cachedValue ? "HIT" : "HIT (Failed)"}] Audio buffer for file ID: ${audioFileId}`,
      );
      return cachedValue; // Return cached buffer or null
    }
    // If undefined, it means the key wasn't actually there, proceed to load (shouldn't happen often with .has check)
  }

  // 2. If not in cache, load from DB
  console.log(`[Cache MISS] Loading audio file ID: ${audioFileId} from DB...`);
  try {
    const audioFileData = await getAudioFile(audioFileId);
    if (!audioFileData?.blob) {
      console.warn(
        `Audio file with ID ${audioFileId} not found or has no blob.`,
      );
      audioBufferCache.set(audioFileId, null); // Cache the failure (not found)
      return null;
    }

    // 3. Decode
    console.log(
      `Decoding audio for file ID: ${audioFileId}, name: ${audioFileData.name}`,
    );
    const decodedBuffer = await decodeAudioBlob(audioFileData.blob);

    // 4. Cache the result
    audioBufferCache.set(audioFileId, decodedBuffer);
    console.log(`[Cache SET] Audio buffer cached for file ID: ${audioFileId}`);
    return decodedBuffer;
  } catch (error) {
    console.error(
      `Error loading/decoding audio file ID ${audioFileId}:`,
      error,
    );
    audioBufferCache.set(audioFileId, null); // Cache the failure (decode error)
    return null; // Return null on error
  }
}

// Play an AudioBuffer with enhanced metadata
export function playAudio(
  buffer: AudioBuffer,
  playbackKey: string, // Unique key to identify this playback instance (e.g., padId)
  metadata: {
    name: string;
    padInfo: {
      profileId: number;
      pageIndex: number;
      padIndex: number;
    };
  },
  volume: number = 1.0, // Volume from 0.0 to 1.0
): AudioBufferSourceNode | null {
  try {
    const context = getAudioContext();

    // Stop any existing sound playing with the same key
    stopAudio(playbackKey);

    const source = context.createBufferSource();
    source.buffer = buffer;

    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(
      Math.max(0, Math.min(1, volume)),
      context.currentTime,
    ); // Clamp volume

    source.connect(gainNode);
    gainNode.connect(context.destination);

    source.onended = () => {
      // Clean up when playback finishes naturally
      console.log(
        `[Audio] Playback naturally finished for key: ${playbackKey}`,
      );
      activeTracks.delete(playbackKey);
      playbackStoreActions.removeTrack(playbackKey); // Remove from store
      stopPlaybackLoop(); // Check if loop should stop
    };

    source.start(0);

    // Store enhanced track information
    activeTracks.set(playbackKey, {
      source,
      name: metadata.name,
      startTime: context.currentTime,
      duration: buffer.duration,
      padInfo: metadata.padInfo,
      isFading: false, // Initialize isFading state
    });

    // Add to playback store
    const initialState: PlaybackState = {
      key: playbackKey,
      name: metadata.name,
      progress: 0,
      remainingTime: buffer.duration,
      totalDuration: buffer.duration,
      isFading: false,
      padInfo: metadata.padInfo,
    };
    playbackStoreActions.addTrack(playbackKey, initialState);

    // Start the rAF loop if it's not already running
    startPlaybackLoop();

    console.log(`[Audio] Playback started for key: ${playbackKey}`);
    return source;
  } catch (error) {
    console.error(`Error playing audio for key ${playbackKey}:`, error);
    return null;
  }
}

// Check if a track is currently fading out by checking the activeTracks map
export function isTrackFading(playbackKey: string): boolean {
  return activeTracks.get(playbackKey)?.isFading === true;
}

// Stop audio playback associated with a specific key
export function stopAudio(playbackKey: string): void {
  const track = activeTracks.get(playbackKey);
  if (track) {
    try {
      track.source.stop(0);
      // Explicitly delete from activeTracks immediately - don't wait for onended
      activeTracks.delete(playbackKey);
      playbackStoreActions.removeTrack(playbackKey); // Remove from store
      stopPlaybackLoop(); // Check if loop should stop
      // No need to clear from fadingTracks anymore
      console.log(
        `[Audio] Playback stopped and removed for key: ${playbackKey}`,
      );
    } catch (error) {
      // Ignore errors if the source was already stopped or in an invalid state
      if ((error as DOMException).name !== "InvalidStateError") {
        console.error(`Error stopping audio for key ${playbackKey}:`, error);
      }
      // Manually clean up if stop fails
      activeTracks.delete(playbackKey);
      playbackStoreActions.removeTrack(playbackKey); // Ensure removal from store on error too
      stopPlaybackLoop(); // Check if loop should stop
      // No need to clear from fadingTracks anymore
    }
  }
}

// Fade out audio over a specified duration
export function fadeOutAudio(
  playbackKey: string,
  durationInSeconds: number = 3,
): void {
  const track = activeTracks.get(playbackKey);
  // If track doesn't exist or is already fading, do nothing
  if (!track || track.isFading) return;

  try {
    const context = getAudioContext();
    const source = track.source;

    // Disconnect the source from its current destination
    source.disconnect();

    // Create a gain node
    const gainNode = context.createGain();
    // Start at current volume (1)
    gainNode.gain.setValueAtTime(1, context.currentTime);
    // Fade to 0 over the specified duration
    gainNode.gain.linearRampToValueAtTime(
      0,
      context.currentTime + durationInSeconds,
    );

    // Connect source -> gain -> destination
    source.connect(gainNode);
    gainNode.connect(context.destination);

    // Mark track as fading directly in the activeTracks map
    track.isFading = true;
    playbackStoreActions.setTrackFading(playbackKey, true); // Update store

    console.log(
      `[Audio] Starting fadeout for key: ${playbackKey} over ${durationInSeconds} seconds`,
    );

    // Remove the track from activeTracks and store after the fade completes
    setTimeout(() => {
      // Only try to stop if it's still active
      if (activeTracks.has(playbackKey)) {
        try {
          source.stop(0);
        } catch {
          // Ignore errors if already stopped
        }
        activeTracks.delete(playbackKey);
        playbackStoreActions.removeTrack(playbackKey); // Remove from store
        stopPlaybackLoop(); // Check if loop should stop
        // No need to clear from fadingTracks anymore
        console.log(`[Audio] Fadeout completed for key: ${playbackKey}`);
      }
    }, durationInSeconds * 1000);
  } catch (error) {
    console.error(`Error fading out audio for key ${playbackKey}:`, error);
    // Fallback to immediate stop if fadeout fails
    stopAudio(playbackKey);
  }
}

// Function to resume AudioContext on user interaction (call this from a UI event handler)
export function resumeAudioContext(): void {
  const context = getAudioContext();
  if (context.state === "suspended") {
    context
      .resume()
      .then(() => {
        console.log("AudioContext resumed successfully.");
      })
      .catch((err) => {
        console.error("Failed to resume AudioContext:", err);
      });
  }
}

// Stop all currently playing audio tracks
export function stopAllAudio(): void {
  // Get all keys from activeTracks Map
  const keys = Array.from(activeTracks.keys());

  // Stop each track
  keys.forEach((key) => {
    stopAudio(key); // stopAudio now handles store removal and loop check
  });

  // Explicitly clear store state after stopping all
  playbackStoreActions.clearAllTracks();
  // Ensure loop is stopped
  stopPlaybackLoop();

  console.log(`[Audio] Stopped all active tracks (${keys.length} tracks)`);
}

// Fade out all currently playing audio tracks
export function fadeOutAllAudio(durationInSeconds: number = 3): void {
  // Get all keys from activeTracks Map
  const keys = Array.from(activeTracks.keys());

  // Fade out each track
  keys.forEach((key) => {
    // Check if the track is already fading to avoid restarting the fade
    if (!isTrackFading(key)) {
      fadeOutAudio(key, durationInSeconds);
    }
  });

  console.log(
    `[Audio] Initiated fade out for all active tracks (${keys.length} tracks) over ${durationInSeconds} seconds`,
  );
  // fadeOutAudio handles individual store updates and loop checks via its timeout
}

// --- Preloading ---

/**
 * Preloads audio files for a given set of IDs by fetching and decoding them into the cache.
 * Does not fail on individual errors, allowing other files to load.
 * @param audioFileIds Array of audio file IDs to preload.
 */
export async function preloadAudioForPage(
  audioFileIds: number[],
): Promise<void> {
  if (!isClient) return; // Only run on client

  const uniqueIds = [...new Set(audioFileIds)].filter(
    (id) => typeof id === "number" && !isNaN(id),
  ); // Ensure unique, valid numbers
  if (uniqueIds.length === 0) return;

  console.log(
    `[Audio Preload] Starting preload for ${uniqueIds.length} unique audio file IDs...`,
  );
  const startTime = performance.now();

  const preloadPromises = uniqueIds.map((id) =>
    loadAndDecodeAudio(id).catch((error) => {
      // Catch errors during individual loads/decodes so Promise.allSettled works
      console.error(`[Audio Preload] Error preloading ID ${id}:`, error);
      return null; // Indicate failure for this specific ID
    }),
  );

  const results = await Promise.allSettled(preloadPromises);

  const endTime = performance.now();
  const duration = endTime - startTime;
  const successfulCount = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null,
  ).length;
  const failedCount = results.length - successfulCount;

  console.log(
    `[Audio Preload] Finished preloading ${results.length} files in ${duration.toFixed(2)}ms. Success: ${successfulCount}, Failed: ${failedCount}`,
  );
}

// Preload common sounds or handle initial context state if needed
// Example: Ensure context is ready on load
// getAudioContext(); // Call early if desired, but user interaction is often required first
