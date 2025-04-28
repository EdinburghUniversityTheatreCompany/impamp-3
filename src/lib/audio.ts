import { getAudioFile, PadConfiguration, PlaybackType } from "./db";
import { playbackStoreActions } from "@/store/playbackStore";
import type { PlaybackState } from "@/store/playbackStore";
import { useProfileStore } from "@/store/profileStore";

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

// Define interface for active track information, including multi-sound state
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
  isFading: boolean;
  // --- Multi-sound state ---
  playbackType: PlaybackType;
  allAudioFileIds: number[]; // The full list for this pad
  currentAudioFileId: number; // The specific ID currently playing
  currentAudioIndex?: number; // Index within allAudioFileIds for sequential/round-robin state
  availableAudioIndices?: number[]; // Remaining indices for round-robin
}

let audioContext: AudioContext | null = null;
const activeTracks: Map<string, ActiveTrack> = new Map(); // Enhanced tracking with metadata

// State map for round-robin playback (Key: pad playbackKey, Value: remaining audioFileIds indices)
const roundRobinState = new Map<string, number[]>();
// State map for sequential playback (Key: pad playbackKey, Value: next index to play)
const sequentialState = new Map<string, number>();

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

// --- Public function to trigger pad playback ---

/**
 * Handles the user interaction to play a pad's audio.
 * Checks activePadBehavior, selects the correct audio file based on playbackType,
 * loads audio if needed, and calls _playBuffer.
 */
export async function triggerAudioForPad(args: {
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  activeProfileId: number;
  currentPageIndex: number;
  name?: string; // Optional name for metadata
}): Promise<void> {
  // Destructure args for easier access
  const {
    padIndex,
    audioFileIds,
    playbackType,
    activeProfileId,
    currentPageIndex,
    name,
  } = args;

  // Check if there are any audio files configured
  if (!audioFileIds || audioFileIds.length === 0) {
    console.log(
      `[triggerAudioForPad] Pad index ${padIndex} has no audio files configured.`,
    );
    return;
  }

  const playbackKey = `pad-${activeProfileId}-${currentPageIndex}-${padIndex}`;
  const isAlreadyPlaying = activeTracks.has(playbackKey);
  const activePadBehavior = useProfileStore.getState().getActivePadBehavior();

  console.log(
    `[Audio Trigger] Key: ${playbackKey}, Is Playing: ${isAlreadyPlaying}, Behavior: ${activePadBehavior}`,
  );

  // Handle behavior if the track is already playing
  if (isAlreadyPlaying) {
    switch (activePadBehavior) {
      case "continue":
        console.log(
          `[Audio Trigger Action] Behavior=continue. Doing nothing for key: ${playbackKey}`,
        );
        return; // Do nothing
      case "stop":
        console.log(
          `[Audio Trigger Action] Behavior=stop. Stopping key: ${playbackKey}`,
        );
        stopAudio(playbackKey); // Stop the existing sound
        // Reset round-robin state for this pad if it was stopped
        if (playbackType === "round-robin") {
          roundRobinState.delete(playbackKey);
          console.log(
            `[Audio Trigger Action] Reset round-robin state for key: ${playbackKey}`,
          );
        }
        return; // Don't proceed to play again
      case "restart": {
        // Use block scope for clarity
        console.log(
          `[Audio Trigger Action] Behavior=restart. Handling restart for key: ${playbackKey}`,
        );
        const existingTrack = activeTracks.get(playbackKey);
        if (existingTrack) {
          console.log(
            `[Audio Trigger Action] Nullifying onended and stopping existing source for key: ${playbackKey}`,
          );

          existingTrack.source.onended = null; // Prevent old onended from firing later
          try {
            existingTrack.source.stop(0); // Stop only the Web Audio source
          } catch (error) {
            // Ignore errors if the source was already stopped or in an invalid state
            if ((error as DOMException).name !== "InvalidStateError") {
              console.error(
                `[Audio Trigger Action] Error stopping existing source during restart for key ${playbackKey}:`,
                error,
              );
            }
          }
          // DO NOT remove from activeTracks or playbackStore here. _playBuffer will update the entry.
        } else {
          console.warn(
            `[Audio Trigger Action] Restart requested for key ${playbackKey}, but no existing track found in activeTracks map.`,
          );
        }
        // Proceed to play again (logic continues below)
        break;
      }
      default:
        console.warn(
          `[Audio Trigger] Unknown activePadBehavior: ${activePadBehavior}. Defaulting to 'continue'.`,
        );
        return; // Default to continue
    }
  }

  // --- Select Audio File ID based on Playback Type ---
  let audioFileIdToPlay: number | undefined;
  let currentAudioIndex: number | undefined;
  let availableAudioIndices: number[] | undefined;

  switch (playbackType) {
    case "sequential":
      // Get the next index for this pad, default to 0 if not found
      currentAudioIndex = sequentialState.get(playbackKey) ?? 0;
      if (currentAudioIndex >= audioFileIds.length) {
        currentAudioIndex = 0; // Wrap around if index is out of bounds
      }
      audioFileIdToPlay = audioFileIds[currentAudioIndex];
      // Calculate and store the *next* index for the subsequent trigger
      const nextIndex = (currentAudioIndex + 1) % audioFileIds.length;
      sequentialState.set(playbackKey, nextIndex);
      console.log(
        `[Audio Select] Sequential: Playing ID ${audioFileIdToPlay} (index ${currentAudioIndex}). Next index: ${nextIndex}`,
      );
      break;
    case "random":
      const randomIndex = Math.floor(Math.random() * audioFileIds.length);
      audioFileIdToPlay = audioFileIds[randomIndex];
      currentAudioIndex = randomIndex; // Store the chosen index
      console.log(
        `[Audio Select] Random: Playing ID ${audioFileIdToPlay} (index ${randomIndex})`,
      );
      break;
    case "round-robin":
      let remainingIndices = roundRobinState.get(playbackKey);
      // If no state or state is empty, reset from full list
      if (!remainingIndices || remainingIndices.length === 0) {
        remainingIndices = audioFileIds.map((_, index) => index); // Get indices 0, 1, 2...
        console.log(
          `[Audio Select] Round-Robin: Resetting available indices for key ${playbackKey}:`,
          remainingIndices,
        );
      }
      // Pick a random index *from the remaining indices*
      const randomRemainingIndexPos = Math.floor(
        Math.random() * remainingIndices.length,
      );
      currentAudioIndex = remainingIndices[randomRemainingIndexPos]; // Get the actual audioFileIds index
      audioFileIdToPlay = audioFileIds[currentAudioIndex];
      // Update the state by removing the chosen index
      remainingIndices.splice(randomRemainingIndexPos, 1);
      roundRobinState.set(playbackKey, remainingIndices);
      availableAudioIndices = [...remainingIndices]; // Store copy for ActiveTrack state
      console.log(
        `[Audio Select] Round-Robin: Playing ID ${audioFileIdToPlay} (index ${currentAudioIndex}). Remaining indices for key ${playbackKey}:`,
        remainingIndices,
      );
      break;
    default:
      console.warn(
        `[Audio Select] Unknown playbackType: ${playbackType}. Defaulting to sequential.`,
      );
      audioFileIdToPlay = audioFileIds[0];
      currentAudioIndex = 0;
  }

  if (audioFileIdToPlay === undefined) {
    console.error(
      `[Audio Trigger] Could not determine audioFileId to play for key ${playbackKey}. Args:`,
      args,
    );
    return;
  }

  // --- Proceed to load and play the selected sound ---
  console.log(
    `[Audio Trigger Action] Proceeding to load/play for key: ${playbackKey}, Selected File ID: ${audioFileIdToPlay}`,
  );
  try {
    // Load and decode the audio buffer for the selected ID
    const buffer = await loadAndDecodeAudio(audioFileIdToPlay);

    // If buffer loaded successfully, play it
    if (buffer) {
      console.log(
        `[Audio Trigger Action] Buffer obtained for File ID: ${audioFileIdToPlay}. Calling _playBuffer...`,
      );
      _playBuffer(
        buffer,
        playbackKey,
        {
          // Metadata for display/identification
          name: name || `Pad ${padIndex + 1}`, // Use provided name or fallback
          padInfo: {
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
          },
        },
        1.0, // Default volume
        {
          // Multi-sound state for ActiveTrack
          playbackType: playbackType,
          allAudioFileIds: audioFileIds,
          currentAudioFileId: audioFileIdToPlay,
          currentAudioIndex: currentAudioIndex,
          availableAudioIndices: availableAudioIndices,
        },
      );
    } else {
      console.error(
        `[Audio Trigger] Failed to load or decode audio for File ID: ${audioFileIdToPlay}`,
      );
      // Optionally show an error to the user
    }
  } catch (error) {
    console.error(
      `[Audio Trigger] Error during load/decode for key ${playbackKey}:`,
      error,
    );
    // Optionally show an error to the user
  }
}

// --- Internal Playback Logic ---

// Internal function to play a pre-loaded buffer and update state, now includes multi-sound state
function _playBuffer(
  buffer: AudioBuffer,
  playbackKey: string,
  metadata: {
    // Basic display/ID info
    name: string;
    padInfo: {
      profileId: number;
      pageIndex: number;
      padIndex: number;
    };
  },
  volume: number = 1.0,
  multiSoundState: Pick<
    ActiveTrack, // State specific to multi-sound playback
    | "playbackType"
    | "allAudioFileIds"
    | "currentAudioFileId"
    | "currentAudioIndex"
    | "availableAudioIndices"
  >,
): AudioBufferSourceNode | null {
  try {
    const context = getAudioContext();

    console.log(`[_playBuffer] Starting playback for key: ${playbackKey}`);
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
      isFading: false,
      // --- Include multi-sound state ---
      playbackType: multiSoundState.playbackType,
      allAudioFileIds: multiSoundState.allAudioFileIds,
      currentAudioFileId: multiSoundState.currentAudioFileId,
      currentAudioIndex: multiSoundState.currentAudioIndex,
      availableAudioIndices: multiSoundState.availableAudioIndices,
    });

    // Add to playback store (UI state) - doesn't need the internal multi-sound state
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

// --- Internal Fade Logic ---

/**
 * Internal helper to initiate a fade-out for a track.
 * Handles gain node creation, ramp, state updates, and cleanup scheduling.
 */
function _initiateFade(playbackKey: string, durationInSeconds: number): void {
  const track = activeTracks.get(playbackKey);
  // If track doesn't exist or is already fading, do nothing
  if (!track || track.isFading) return;

  try {
    const context = getAudioContext();
    const source = track.source;

    // Disconnect the source from its current destination to insert the gain node
    source.disconnect();

    // Create a gain node for the fade
    const gainNode = context.createGain();
    // Assume current volume is 1 (or get current gain if more complex volume handling exists)
    // Note: If volume control is implemented elsewhere, this might need adjustment
    gainNode.gain.setValueAtTime(1, context.currentTime);
    // Fade to 0 over the specified duration
    gainNode.gain.linearRampToValueAtTime(
      0,
      context.currentTime + durationInSeconds,
    );

    // Connect source -> gain -> destination
    source.connect(gainNode);
    gainNode.connect(context.destination);

    // Mark track as fading
    track.isFading = true;
    playbackStoreActions.setTrackFading(playbackKey, true); // Update store

    console.log(
      `[Audio] Starting ${durationInSeconds}s fade for key: ${playbackKey}`,
    );

    // Clean up after the fade completes
    setTimeout(() => {
      // Only clean up if the track is still the one we started fading
      // (Handles potential race conditions if stop/play happens rapidly)
      const currentTrack = activeTracks.get(playbackKey);
      if (currentTrack === track) {
        try {
          // Stop the source node after the fade
          source.stop(0);
        } catch (error) {
          // Ignore errors if already stopped (e.g., due to natural end)
          if ((error as DOMException).name !== "InvalidStateError") {
            console.warn(
              `[Audio] Error stopping source during fade cleanup for key ${playbackKey}:`,
              error,
            );
          }
        } finally {
          // Always remove state after fade attempt
          activeTracks.delete(playbackKey);
          playbackStoreActions.removeTrack(playbackKey); // Remove from store
          stopPlaybackLoop(); // Check if loop should stop
          console.log(`[Audio] Fade completed for key: ${playbackKey}`);
        }
      } else {
        console.log(
          `[Audio] Fade cleanup skipped for key ${playbackKey} as track changed or was removed.`,
        );
      }
    }, durationInSeconds * 1000);
  } catch (error) {
    console.error(
      `Error initiating ${durationInSeconds}s fade for key ${playbackKey}:`,
      error,
    );
    // Fallback: If fade setup fails, attempt immediate stop and cleanup
    // This ensures the track is eventually removed even if fading fails.
    if (track) {
      // Re-check track existence inside catch
      console.warn(
        `[Audio] Fade initiation failed for key ${playbackKey}. Attempting fallback immediate stop.`,
      );
      try {
        // Ensure source is stopped if possible
        track.source.stop(0);
      } catch (stopError) {
        if ((stopError as DOMException).name !== "InvalidStateError") {
          console.error(
            `[Audio] Error during fallback stop for key ${playbackKey}:`,
            stopError,
          );
        }
      } finally {
        // Ensure cleanup happens
        activeTracks.delete(playbackKey);
        playbackStoreActions.removeTrack(playbackKey);
        stopPlaybackLoop();
        console.log(
          `[Audio] Fallback immediate stop/cleanup executed for key: ${playbackKey}`,
        );
      }
    }
  }
}

// --- Public Audio Control Functions ---

// Check if a track is currently fading out by checking the activeTracks map
export function isTrackFading(playbackKey: string): boolean {
  return activeTracks.get(playbackKey)?.isFading === true;
}

// Stop audio playback associated with a specific key, applying a short fade-out
export function stopAudio(playbackKey: string): void {
  console.log(
    `[Audio] Requesting stop (with short fade) for key: ${playbackKey}`,
  );
  _initiateFade(playbackKey, 0.1);
}

// Fade out audio over a specified duration
export function fadeOutAudio(
  playbackKey: string,
  durationInSeconds: number = 3,
): void {
  console.log(
    `[Audio] Requesting fade out over ${durationInSeconds}s for key: ${playbackKey}`,
  );
  _initiateFade(playbackKey, durationInSeconds);
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

  // Stop each track (stopAudio handles individual state clearing)
  keys.forEach((key) => {
    stopAudio(key);
  });
  playbackStoreActions.clearAllTracks();
  // Ensure loop is stopped (already handled by stopAudio calls)
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
 * Preloads audio files for a given set of PadConfigurations by fetching and decoding them into the cache.
 * Does not fail on individual errors, allowing other files to load.
 * @param padConfigs Array of PadConfiguration objects for the current page.
 */
export async function preloadAudioForPage(
  padConfigs: PadConfiguration[],
): Promise<void> {
  if (!isClient) return; // Only run on client

  // Extract all unique audio file IDs from all configurations
  const allIds = padConfigs.flatMap((config) => config.audioFileIds || []);
  const uniqueIds = [...new Set(allIds)].filter(
    (id): id is number => typeof id === "number" && !isNaN(id), // Type guard for filtering
  );

  if (uniqueIds.length === 0) {
    console.log("[Audio Preload] No valid audio file IDs found to preload.");
    return;
  }

  console.log(
    `[Audio Preload] Starting preload for ${uniqueIds.length} unique audio file IDs from ${padConfigs.length} pads...`,
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
