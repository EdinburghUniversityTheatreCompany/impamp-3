/**
 * Audio Module - Controls
 *
 * Public API for audio playback control.
 * Acts as the main entry point for triggering playback, stopping, fading, etc.
 * Uses the strategy pattern to handle different playback types.
 *
 * @module lib/audio/controls
 */

import { useProfileStore } from "@/store/profileStore";
import { PadConfiguration } from "../db";
import {
  loadAndDecodeAudioInstant,
  loadAndDecodeAudioEnhanced,
  preloadAudioFiles,
  LoadingState,
} from "./decoder";
import { audioPreloader } from "./preloader";
import { getStrategy } from "./strategies";
import {
  playBuffer,
  stopTrack,
  fadeOutTrack,
  stopAllTracks,
  fadeOutAllTracks,
  isTrackPlaying,
  isTrackFading,
  getActivePlaybackKeys,
} from "./playback";
import { resumeAudioContext, getAudioContext } from "./context";
import { TriggerAudioArgs, generatePlaybackKey } from "./types";

/**
 * Enhanced trigger args with loading state callbacks
 */
export interface TriggerAudioArgsEnhanced extends TriggerAudioArgs {
  onLoadingStateChange?: (state: LoadingState) => void;
  onInstantFeedback?: () => void; // Called immediately when pad is triggered
  onAudioReady?: () => void; // Called when audio starts playing
  onError?: (error: string) => void; // Called if loading/playback fails
}

/**
 * Error recovery configuration
 */
interface ErrorRecoveryConfig {
  maxRetries: number;
  retryDelayMs: number;
  fallbackToSilence: boolean;
  showUserNotification: boolean;
}

/**
 * Default error recovery settings
 */
const DEFAULT_ERROR_RECOVERY: ErrorRecoveryConfig = {
  maxRetries: 2,
  retryDelayMs: 1000,
  fallbackToSilence: false,
  showUserNotification: true,
};

/**
 * Create a silent audio buffer as fallback for failed loads
 *
 * @param durationInSeconds - Duration of silent buffer (default: 0.1s)
 * @returns Silent AudioBuffer
 */
function createSilentBuffer(durationInSeconds: number = 0.1): AudioBuffer {
  const context = getAudioContext();
  const sampleRate = context.sampleRate;
  const numberOfChannels = 2; // Stereo
  const length = sampleRate * durationInSeconds;

  const buffer = context.createBuffer(numberOfChannels, length, sampleRate);

  // Fill with silence (already initialized to 0, but explicit for clarity)
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    channelData.fill(0);
  }

  return buffer;
}

/**
 * Attempt to recover from audio loading errors with retry logic
 *
 * @param audioFileId - ID of the failed audio file
 * @param onStateChange - Loading state callback
 * @param config - Error recovery configuration
 * @param attemptNumber - Current attempt number (for recursion)
 * @returns Promise that resolves to recovered AudioBuffer or null
 */
async function recoverFromLoadError(
  audioFileId: number,
  onStateChange?: LoadingStateCallback,
  config: ErrorRecoveryConfig = DEFAULT_ERROR_RECOVERY,
  attemptNumber: number = 1,
): Promise<AudioBuffer | null> {
  if (attemptNumber > config.maxRetries) {
    console.warn(
      `[Audio Controls] Max retries (${config.maxRetries}) exceeded for audio file ID: ${audioFileId}`,
    );

    if (config.fallbackToSilence) {
      console.log(
        `[Audio Controls] Falling back to silent buffer for ID: ${audioFileId}`,
      );
      onStateChange?.({
        audioFileId,
        status: "ready",
        progress: 1,
        startTime: performance.now(),
      });
      return createSilentBuffer();
    }

    return null;
  }

  console.log(
    `[Audio Controls] Attempting recovery for audio file ID: ${audioFileId} (attempt ${attemptNumber}/${config.maxRetries})`,
  );

  onStateChange?.({
    audioFileId,
    status: "loading",
    progress: 0,
    startTime: performance.now(),
  });

  // Wait before retry (exponential backoff)
  await new Promise((resolve) =>
    setTimeout(resolve, config.retryDelayMs * attemptNumber),
  );

  try {
    // Clear any cached failure state for this file before retry
    const { clearCachedAudioBuffer } = await import("./cache");
    clearCachedAudioBuffer(audioFileId);

    // Attempt to load again using enhanced method
    const buffer = await loadAndDecodeAudioEnhanced(audioFileId, onStateChange);

    if (buffer) {
      console.log(
        `[Audio Controls] Recovery successful for audio file ID: ${audioFileId} on attempt ${attemptNumber}`,
      );
      return buffer;
    }

    // If still null, try again
    return recoverFromLoadError(
      audioFileId,
      onStateChange,
      config,
      attemptNumber + 1,
    );
  } catch (error) {
    console.error(
      `[Audio Controls] Recovery attempt ${attemptNumber} failed for ID ${audioFileId}:`,
      error,
    );
    return recoverFromLoadError(
      audioFileId,
      onStateChange,
      config,
      attemptNumber + 1,
    );
  }
}

/**
 * Handle graceful fallback when audio fails to load or play
 *
 * @param audioFileIds - All available audio file IDs for this pad
 * @param failedAudioFileId - The ID that failed to load
 * @param onStateChange - Loading state callback
 * @param onError - Error callback
 * @returns Promise that resolves to a fallback AudioBuffer or null
 */
async function handleAudioFallback(
  audioFileIds: number[],
  failedAudioFileId: number,
  onStateChange?: LoadingStateCallback,
  onError?: (error: string) => void,
): Promise<AudioBuffer | null> {
  console.log(
    `[Audio Controls] Handling fallback for failed audio file ID: ${failedAudioFileId}`,
  );

  // Try to find an alternative audio file for this pad
  const alternativeIds = audioFileIds.filter((id) => id !== failedAudioFileId);

  for (const alternativeId of alternativeIds) {
    console.log(
      `[Audio Controls] Trying alternative audio file ID: ${alternativeId}`,
    );

    try {
      const buffer = await loadAndDecodeAudioEnhanced(
        alternativeId,
        onStateChange,
      );
      if (buffer) {
        console.log(
          `[Audio Controls] Successfully loaded alternative audio file ID: ${alternativeId}`,
        );
        return buffer;
      }
    } catch (error) {
      console.warn(
        `[Audio Controls] Alternative audio file ID ${alternativeId} also failed:`,
        error,
      );
      continue;
    }
  }

  // If no alternatives work, try error recovery on the original file
  console.log(
    `[Audio Controls] No alternatives available, attempting error recovery for ID: ${failedAudioFileId}`,
  );

  const recoveredBuffer = await recoverFromLoadError(
    failedAudioFileId,
    onStateChange,
  );

  if (!recoveredBuffer) {
    const errorMsg = `All audio files failed to load for this pad. Original ID: ${failedAudioFileId}, Alternatives tried: ${alternativeIds.length}`;
    onError?.(errorMsg);
    console.error(`[Audio Controls] ${errorMsg}`);
  }

  return recoveredBuffer;
}

/**
 * Triggers audio playback for a pad (Legacy API - now uses instant response internally)
 *
 * This function maintains backward compatibility while providing all the benefits
 * of instant response, progressive loading, and error recovery under the hood.
 *
 * @param args - Configuration for triggering audio
 * @returns Promise that resolves when audio playback has been triggered (or failed)
 */
export async function triggerAudioForPad(
  args: TriggerAudioArgs,
): Promise<void> {
  console.log(`[Audio Controls] [Legacy API] Triggering pad ${args.padIndex} via legacy wrapper`);
  
  // Simply delegate to the instant version with basic callbacks
  // This gives all callers instant response and error recovery automatically
  return triggerAudioForPadInstant({
    ...args,
    onInstantFeedback: () => {
      // Legacy callers don't need to know about instant feedback
      console.log(`[Audio Controls] [Legacy] Instant feedback for pad ${args.padIndex}`);
    },
    onLoadingStateChange: (state: LoadingState) => {
      // Legacy callers don't handle loading states, but we can log for debugging
      console.log(`[Audio Controls] [Legacy] Loading state for pad ${args.padIndex}:`, state.status, `${Math.round((state.progress || 0) * 100)}%`);
    },
    onAudioReady: () => {
      console.log(`[Audio Controls] [Legacy] Audio ready for pad ${args.padIndex}`);
    },
    onError: (error: string) => {
      console.error(`[Audio Controls] [Legacy] Error for pad ${args.padIndex}:`, error);
    },
  });
}

/**
 * Triggers audio playback for a pad with instant response and loading feedback
 *
 * Provides immediate user feedback even when audio needs to be loaded.
 * Shows loading states and handles errors gracefully.
 *
 * @param args - Enhanced configuration for triggering audio with callbacks
 * @returns Promise that resolves when audio playback has been initiated or failed
 */
export async function triggerAudioForPadInstant(
  args: TriggerAudioArgsEnhanced,
): Promise<void> {
  const {
    padIndex,
    audioFileIds,
    playbackType,
    activeProfileId,
    currentPageIndex,
    name,
    onLoadingStateChange,
    onInstantFeedback,
    onAudioReady,
    onError,
  } = args;

  // Provide instant feedback to user
  onInstantFeedback?.();

  // Check if there are any audio files configured
  if (!audioFileIds || audioFileIds.length === 0) {
    console.log(
      `[Audio Controls] Pad ${padIndex} has no audio files configured.`,
    );
    onError?.("No audio files configured for this pad");
    return;
  }

  // Generate a unique key for this pad's playback
  const playbackKey = generatePlaybackKey(
    activeProfileId,
    currentPageIndex,
    padIndex,
  );
  const isAlreadyPlaying = isTrackPlaying(playbackKey);

  // Get the active pad behavior from the profile store
  const activePadBehavior = useProfileStore.getState().getActivePadBehavior();

  console.log(
    `[Audio Controls] [Instant] Triggering pad ${padIndex}, key: ${playbackKey}, ` +
      `Is Playing: ${isAlreadyPlaying}, Behavior: ${activePadBehavior}, ` +
      `Playback Type: ${playbackType}, Audio Files: ${audioFileIds.length}`,
  );

  // Handle behavior if the track is already playing
  if (isAlreadyPlaying) {
    switch (activePadBehavior) {
      case "continue":
        console.log(
          `[Audio Controls] [Instant] Behavior=continue. Doing nothing for key: ${playbackKey}`,
        );
        return;

      case "stop":
        console.log(
          `[Audio Controls] [Instant] Behavior=stop. Stopping key: ${playbackKey}`,
        );
        stopTrack(playbackKey);
        return;

      case "restart":
        console.log(
          `[Audio Controls] [Instant] Behavior=restart. Handling restart for key: ${playbackKey}`,
        );
        stopTrack(playbackKey);
        break;

      default:
        console.warn(
          `[Audio Controls] [Instant] Unknown activePadBehavior: ${activePadBehavior}. Defaulting to 'continue'.`,
        );
        return;
    }
  }

  try {
    // Use the strategy pattern to select which audio file to play
    const strategy = getStrategy(playbackType);
    const { audioFileId, index } = strategy.selectNextSound(audioFileIds);

    // Use instant loading with progress feedback
    let buffer = await loadAndDecodeAudioInstant(
      audioFileId,
      onLoadingStateChange,
      // onPartialReady callback for progressive playback
      () => {
        console.log(
          `[Audio Controls] [Instant] Partial audio ready for ID: ${audioFileId}`,
        );
        // Start playback immediately when partial buffer is available
        onAudioReady?.();
      },
    );

    // If primary loading failed, attempt fallback and recovery
    if (!buffer) {
      console.warn(
        `[Audio Controls] [Instant] Primary load failed for ID: ${audioFileId}, attempting fallback...`,
      );

      buffer = await handleAudioFallback(
        audioFileIds,
        audioFileId,
        onLoadingStateChange,
        onError,
      );
    }

    if (buffer) {
      // Track this file as recently played for intelligent preloading
      audioPreloader.trackPlayedFile(audioFileId);

      console.log(
        `[Audio Controls] [Instant] Playing audio file ID: ${audioFileId} for pad ${padIndex}`,
      );

      // Update strategy state after selection
      strategy.updateState(index, audioFileIds);

      // Notify that audio is ready and starting
      onAudioReady?.();

      // Play the buffer with the appropriate parameters
      playBuffer(buffer, playbackKey, {
        name: name || `Pad ${padIndex + 1}`,
        padInfo: {
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex,
        },
        multiSoundState: {
          playbackType,
          allAudioFileIds: audioFileIds,
          currentAudioFileId: audioFileId,
          currentAudioIndex: index,
          availableAudioIndices:
            playbackType === "round-robin"
              ? (
                  getStrategy(
                    "round-robin",
                  ) as import("./strategies/roundRobin").RoundRobinStrategy
                ).getAvailableIndices?.()
              : undefined,
        },
      });
    } else {
      const errorMsg = `Failed to load audio file ID: ${audioFileId} for pad ${padIndex}`;
      console.error(`[Audio Controls] [Instant] ${errorMsg}`);
      onError?.(errorMsg);
    }
  } catch (error) {
    const errorMsg = `Error triggering audio for pad ${padIndex}: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(`[Audio Controls] [Instant] ${errorMsg}`, error);
    onError?.(errorMsg);
  }
}

/**
 * Stops audio playback
 *
 * @param playbackKey - The key identifying the playback to stop
 */
export function stopAudio(playbackKey: string): void {
  console.log(`[Audio Controls] Requesting stop for key: ${playbackKey}`);
  stopTrack(playbackKey);
}

/**
 * Fades out audio over the specified duration
 *
 * @param playbackKey - The key identifying the playback to fade out
 * @param durationInSeconds - Duration of the fade in seconds (default: 3s)
 */
export function fadeOutAudio(
  playbackKey: string,
  durationInSeconds: number = 3,
): void {
  console.log(
    `[Audio Controls] Requesting fade out over ${durationInSeconds}s for key: ${playbackKey}`,
  );
  fadeOutTrack(playbackKey, durationInSeconds);
}

/**
 * Stops all currently playing audio tracks
 */
export function stopAllAudio(): void {
  const count = stopAllTracks();
  console.log(`[Audio Controls] Stopped all audio tracks (${count} tracks)`);
}

/**
 * Fades out all currently playing audio tracks
 *
 * @param durationInSeconds - Duration of the fade in seconds (default: 3s)
 */
export function fadeOutAllAudio(durationInSeconds: number = 3): void {
  const count = fadeOutAllTracks(durationInSeconds);
  console.log(
    `[Audio Controls] Fading out all audio tracks (${count} tracks) over ${durationInSeconds}s`,
  );
}

/**
 * Returns an array of all currently playing audio keys
 *
 * @returns Array of playback keys
 */
export function getPlayingAudioKeys(): string[] {
  return getActivePlaybackKeys();
}

/**
 * Checks if a specific audio track is playing
 *
 * @param playbackKey - The key identifying the playback
 * @returns True if the track is playing
 */
export function isAudioPlaying(playbackKey: string): boolean {
  return isTrackPlaying(playbackKey);
}

/**
 * Checks if a specific audio track is fading out
 *
 * @param playbackKey - The key identifying the playback
 * @returns True if the track is fading
 */
export function isAudioFading(playbackKey: string): boolean {
  return isTrackFading(playbackKey);
}

/**
 * Ensures the audio context is active
 * Should be called on user interaction to satisfy browser autoplay policy
 *
 * @returns Promise that resolves when the context is resumed
 */
export async function ensureAudioContextActive(): Promise<void> {
  try {
    await resumeAudioContext();
  } catch (error) {
    console.error("[Audio Controls] Failed to resume audio context:", error);
  }
}

/**
 * Preloads audio for a collection of pad configurations (DEPRECATED - use intelligent preloader)
 *
 * @deprecated Use audioPreloader.preloadCurrentPage() instead for better performance
 * @param padConfigs - Array of pad configurations containing audio file IDs
 * @returns Promise that resolves when preloading is complete
 */
export async function preloadAudioForPage(
  padConfigs: PadConfiguration[],
): Promise<void> {
  // Extract all unique audio file IDs from all configurations
  const allIds = padConfigs.flatMap((config) => config.audioFileIds || []);
  const uniqueIds = [...new Set(allIds)].filter(Boolean);

  if (uniqueIds.length === 0) {
    console.log("[Audio Controls] No audio files to preload.");
    return;
  }

  console.log(
    `[Audio Controls] [DEPRECATED] Preloading ${uniqueIds.length} audio files for the current page...`,
  );

  try {
    await preloadAudioFiles(uniqueIds);
    console.log(
      `[Audio Controls] Preloading complete for ${uniqueIds.length} audio files.`,
    );
  } catch (error) {
    console.error("[Audio Controls] Error during audio preloading:", error);
  }
}

/**
 * Intelligent preloading for current page with priority-based loading
 *
 * @param padConfigs - Array of pad configurations for the current page
 * @param profileId - ID of the active profile
 * @param pageIndex - Index of the current page
 */
export function preloadCurrentPageIntelligent(
  padConfigs: PadConfiguration[],
  profileId: number,
  pageIndex: number,
): void {
  audioPreloader.preloadCurrentPage(padConfigs, profileId, pageIndex);
}

/**
 * Preload files on hover for anticipatory loading
 *
 * @param audioFileIds - Audio file IDs to preload
 * @param context - Context information for the preload
 */
export function preloadOnHover(
  audioFileIds: number[],
  context: { profileId: number; pageIndex: number; padIndex: number },
): void {
  audioPreloader.preloadOnHover(audioFileIds, context);
}

/**
 * Background preload of all configured audio files across all pages
 *
 * @param allPadConfigs - All pad configurations across all pages
 * @param profileId - ID of the active profile
 */
export function preloadAllConfiguredFiles(
  allPadConfigs: PadConfiguration[],
  profileId: number,
): void {
  audioPreloader.preloadAllConfigured(allPadConfigs, profileId);
}

/**
 * Get preloading statistics
 */
export function getPreloadingStats() {
  return audioPreloader.getStats();
}
