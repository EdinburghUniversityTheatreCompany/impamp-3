/**
 * Audio Module - Core Playback
 *
 * Handles the creation and management of audio playback sources.
 * Provides functions for playing, stopping, and fading audio.
 *
 * @module lib/audio/playback
 */

import { getAudioContext } from "./context";
import { ActiveTrack, PlayAudioParams } from "./types";
import { playbackStoreActions } from "@/store/playbackStore";

// Track all currently active audio tracks
const activeTracks = new Map<string, ActiveTrack>();

// rAF loop ID
let rAFId: number | null = null;

// Previous playback state for change detection
let previousPlaybackState = new Map<
  string,
  {
    progress: number;
    remainingTime: number;
    isFading: boolean;
  }
>();

// Reusable objects to reduce garbage collection pressure

/**
 * Creates an audio source node for playback
 *
 * @param buffer - The audio buffer to play
 * @param volume - The volume level (0.0 to 1.0)
 * @returns Object containing source node and gain node
 */
function createAudioSource(
  buffer: AudioBuffer,
  volume: number = 1.0,
): { source: AudioBufferSourceNode; gainNode: GainNode } {
  const context = getAudioContext();

  // Create source node and assign buffer
  const source = context.createBufferSource();
  source.buffer = buffer;

  // Create gain node for volume control and fading
  const gainNode = context.createGain();
  gainNode.gain.setValueAtTime(
    Math.max(0, Math.min(1, volume)), // Clamp volume between 0 and 1
    context.currentTime,
  );

  // Connect nodes together
  source.connect(gainNode);
  gainNode.connect(context.destination);

  return { source, gainNode };
}

/**
 * Plays an audio buffer with the specified parameters
 *
 * @param buffer - The audio buffer to play
 * @param playbackKey - Unique identifier for this playback instance
 * @param params - Configuration for playback
 * @returns The created audio source node or null if playback failed
 */
export function playBuffer(
  buffer: AudioBuffer,
  playbackKey: string,
  params: PlayAudioParams,
): AudioBufferSourceNode | null {
  try {
    const context = getAudioContext();
    const volume = params.volume ?? 1.0;

    console.log(`[Audio Playback] Starting playback for key: ${playbackKey}`);

    // Create audio source
    const { source } = createAudioSource(buffer, volume);

    // Set up onended handler for cleanup
    source.onended = () => {
      // Clean up when playback finishes naturally
      console.log(
        `[Audio Playback] Playback naturally finished for key: ${playbackKey}`,
      );
      activeTracks.delete(playbackKey);
      previousPlaybackState.delete(playbackKey); // Clean up change detection state
      playbackStoreActions.removeTrack(playbackKey);
      stopPlaybackLoop(); // Check if loop should stop
    };

    // Start playback
    source.start(0);

    // Store track information
    const track: ActiveTrack = {
      source,
      name: params.name,
      startTime: context.currentTime,
      duration: buffer.duration,
      padInfo: params.padInfo,
      isFading: false,
      // Include multi-sound state
      playbackType: params.multiSoundState.playbackType,
      allAudioFileIds: params.multiSoundState.allAudioFileIds,
      currentAudioFileId: params.multiSoundState.currentAudioFileId,
      currentAudioIndex: params.multiSoundState.currentAudioIndex,
      availableAudioIndices: params.multiSoundState.availableAudioIndices,
    };

    activeTracks.set(playbackKey, track);

    // Add to playback store (UI state)
    const initialState = {
      key: playbackKey,
      name: params.name,
      progress: 0,
      remainingTime: buffer.duration,
      totalDuration: buffer.duration,
      isFading: false,
      padInfo: params.padInfo,
    };

    playbackStoreActions.addTrack(playbackKey, initialState);

    // Start the rAF loop if it's not already running
    startPlaybackLoop();

    console.log(
      `[Audio Playback] Successfully started playback for key: ${playbackKey}`,
    );
    return source;
  } catch (error) {
    console.error(
      `[Audio Playback] Error playing audio for key ${playbackKey}:`,
      error,
    );
    return null;
  }
}

/**
 * Checks if a track is currently playing
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track is playing
 */
export function isTrackPlaying(playbackKey: string): boolean {
  return activeTracks.has(playbackKey);
}

/**
 * Checks if a track is currently fading out
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track is fading
 */
export function isTrackFading(playbackKey: string): boolean {
  return activeTracks.get(playbackKey)?.isFading === true;
}

/**
 * Gets all currently active playback keys
 *
 * @returns Array of active playback keys
 */
export function getActivePlaybackKeys(): string[] {
  return Array.from(activeTracks.keys());
}

/**
 * Gets information about a specific active track
 *
 * @param playbackKey - The unique key for the playback
 * @returns The active track information or null if not found
 */
export function getActiveTrack(playbackKey: string): ActiveTrack | null {
  return activeTracks.get(playbackKey) || null;
}

/**
 * Initiates a fade-out for a track
 *
 * @param playbackKey - The unique key for the playback
 * @param durationInSeconds - Duration of the fade-out in seconds
 * @returns True if fade-out was initiated successfully
 */
export function fadeOutTrack(
  playbackKey: string,
  durationInSeconds: number,
): boolean {
  const track = activeTracks.get(playbackKey);

  // If track doesn't exist or is already fading, do nothing
  if (!track || track.isFading) return false;

  try {
    const context = getAudioContext();
    const source = track.source;

    // Disconnect the source from its current destination to insert the gain node
    source.disconnect();

    // Create a gain node for the fade
    const gainNode = context.createGain();
    // Start at current volume (assume 1)
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
    playbackStoreActions.setTrackFading(playbackKey, true);

    console.log(
      `[Audio Playback] Starting ${durationInSeconds}s fade for key: ${playbackKey}`,
    );

    // Clean up after the fade completes
    setTimeout(() => {
      // Only clean up if the track is still the one we started fading
      const currentTrack = activeTracks.get(playbackKey);
      if (currentTrack === track) {
        try {
          // Stop the source node after the fade
          source.stop(0);
        } catch (error) {
          // Ignore errors if already stopped (e.g., due to natural end)
          if ((error as DOMException).name !== "InvalidStateError") {
            console.warn(
              `[Audio Playback] Error stopping source during fade cleanup for key ${playbackKey}:`,
              error,
            );
          }
        } finally {
          // Always remove state after fade attempt
          activeTracks.delete(playbackKey);
          previousPlaybackState.delete(playbackKey); // Clean up change detection state
          playbackStoreActions.removeTrack(playbackKey);
          stopPlaybackLoop(); // Check if loop should stop
          console.log(
            `[Audio Playback] Fade completed for key: ${playbackKey}`,
          );
        }
      } else {
        console.log(
          `[Audio Playback] Fade cleanup skipped for key ${playbackKey} as track changed or was removed.`,
        );
      }
    }, durationInSeconds * 1000);

    return true;
  } catch (error) {
    console.error(
      `[Audio Playback] Error initiating ${durationInSeconds}s fade for key ${playbackKey}:`,
      error,
    );

    // Fallback: If fade setup fails, attempt immediate stop and cleanup
    try {
      if (track) {
        console.warn(
          `[Audio Playback] Fade initiation failed for key ${playbackKey}. Attempting fallback immediate stop.`,
        );
        track.source.stop(0);
        activeTracks.delete(playbackKey);
        previousPlaybackState.delete(playbackKey); // Clean up change detection state
        playbackStoreActions.removeTrack(playbackKey);
        stopPlaybackLoop();
      }
    } catch (stopError) {
      console.error(
        `[Audio Playback] Error during fallback stop for key ${playbackKey}:`,
        stopError,
      );
    }

    return false;
  }
}

/**
 * Stops playback of a track immediately with a short fade-out
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track was stopped successfully
 */
export function stopTrack(playbackKey: string): boolean {
  console.log(`[Audio Playback] Requesting stop for key: ${playbackKey}`);
  return fadeOutTrack(playbackKey, 0.1); // Very short fade to avoid clicks
}

/**
 * Stops all currently playing audio tracks
 *
 * @returns Number of tracks that were stopped
 */
export function stopAllTracks(): number {
  // Get all keys from activeTracks
  const keys = Array.from(activeTracks.keys());

  // Stop each track
  let stoppedCount = 0;
  keys.forEach((key) => {
    if (stopTrack(key)) {
      stoppedCount++;
    }
  });

  // Clear the store
  playbackStoreActions.clearAllTracks();

  console.log(
    `[Audio Playback] Stopped ${stoppedCount}/${keys.length} active tracks`,
  );
  return stoppedCount;
}

/**
 * Fade out all currently playing audio tracks
 *
 * @param durationInSeconds - Duration of the fade-out in seconds
 * @returns Number of tracks that were faded out
 */
export function fadeOutAllTracks(durationInSeconds: number = 3): number {
  const keys = Array.from(activeTracks.keys());

  let fadedCount = 0;
  keys.forEach((key) => {
    // Check if the track is already fading to avoid restarting the fade
    if (!isTrackFading(key)) {
      if (fadeOutTrack(key, durationInSeconds)) {
        fadedCount++;
      }
    }
  });

  console.log(
    `[Audio Playback] Initiated fade out for ${fadedCount}/${keys.length} active tracks over ${durationInSeconds} seconds`,
  );

  return fadedCount;
}

// --- Playback Monitoring Loop ---

/**
 * Threshold for progress change detection (0.1% = 0.001)
 * Prevents unnecessary updates for tiny progress changes
 */
const PROGRESS_CHANGE_THRESHOLD = 0.001;

/**
 * Threshold for time change detection (10ms)
 * Prevents updates for sub-frame time changes
 */
const TIME_CHANGE_THRESHOLD = 0.01;

/**
 * Check if playback state has meaningfully changed
 */
function hasPlaybackStateChanged(
  key: string,
  newProgress: number,
  newRemainingTime: number,
  newIsFading: boolean,
): boolean {
  const previous = previousPlaybackState.get(key);

  if (!previous) {
    return true; // New track, definitely changed
  }

  // Check for meaningful changes
  const progressChanged =
    Math.abs(newProgress - previous.progress) >= PROGRESS_CHANGE_THRESHOLD;
  const timeChanged =
    Math.abs(newRemainingTime - previous.remainingTime) >=
    TIME_CHANGE_THRESHOLD;
  const fadingChanged = newIsFading !== previous.isFading;

  return progressChanged || timeChanged || fadingChanged;
}

/**
 * Optimized single frame of the playback monitoring loop
 * Only updates UI state when values actually change
 */
function playbackLoopTick() {
  if (!getAudioContext || activeTracks.size === 0) {
    stopPlaybackLoop(); // Stop if context lost or no tracks
    return;
  }

  const context = getAudioContext();
  const currentTime = context.currentTime;
  let hasAnyChanges = false;
  const currentPlaybackState = new Map();
  const newPreviousState = new Map();

  activeTracks.forEach((track, key) => {
    const elapsed = currentTime - track.startTime;
    const remaining = Math.max(0, track.duration - elapsed);
    const progress = Math.min(1, elapsed / track.duration);

    // If remaining time is effectively zero and it's not already fading,
    // treat it as ended (handles cases where onended might be delayed)
    if (remaining <= 0 && !track.isFading) {
      // This track should be removed, but let onended handle the primary cleanup.
      // We'll just exclude it from the state update for this tick.
      return; // Skip adding to current state if naturally ended
    }

    // Check if this track's state has meaningfully changed
    const hasChanged = hasPlaybackStateChanged(
      key,
      progress,
      remaining,
      track.isFading,
    );

    if (hasChanged) {
      hasAnyChanges = true;
    }

    // Create state object - reuse object structure to reduce garbage collection
    // Note: We still create new objects per track, but with consistent structure
    currentPlaybackState.set(key, {
      key,
      name: track.name,
      remainingTime: remaining,
      totalDuration: track.duration,
      progress: progress,
      isFading: track.isFading,
      padInfo: track.padInfo,
    });

    // Update our change detection state - create new object for each track
    newPreviousState.set(key, {
      progress,
      remainingTime: remaining,
      isFading: track.isFading,
    });
  });

  // Update previous state for next comparison
  previousPlaybackState = newPreviousState;

  // Only update Zustand store if something actually changed
  if (currentPlaybackState.size > 0) {
    if (hasAnyChanges) {
      playbackStoreActions.setPlaybackState(currentPlaybackState);
    }
    // Always schedule next frame regardless of changes (tracks are still playing)
    rAFId = requestAnimationFrame(playbackLoopTick);
  } else {
    // No tracks left, stop the loop and clear previous state
    previousPlaybackState.clear();
    stopPlaybackLoop();
  }
}

/**
 * Starts the playback monitoring loop if not already running
 */
function startPlaybackLoop() {
  // Only start if we have tracks and the loop isn't already running
  if (
    rAFId === null &&
    activeTracks.size > 0 &&
    typeof window !== "undefined"
  ) {
    console.log("[Audio Playback] Starting playback monitoring loop...");
    rAFId = requestAnimationFrame(playbackLoopTick);
  }
}

/**
 * Stops the playback monitoring loop
 */
function stopPlaybackLoop() {
  if (rAFId !== null) {
    console.log("[Audio Playback] Stopping playback monitoring loop.");
    cancelAnimationFrame(rAFId);
    rAFId = null;
  }
}
