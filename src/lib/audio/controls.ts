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
import { PadConfiguration, getAudioFile } from "../db";
import {
  loadAndDecodeAudioInstant,
  loadAndDecodeAudioEnhanced,
  LoadingState,
} from "./decoder";
import { getCachedAudioBuffer } from "./cache";
import { audioPreloader } from "./preloader";
import { getStrategy } from "./strategies";
import {
  playBuffer,
  playBlobStreaming,
  waitForStreamingPlayable,
  stopTrack,
  fadeOutTrack,
  stopAllTracks,
  fadeOutAllTracks,
  isTrackPlaying,
  isTrackFading,
  getActiveTrack,
  getStopGeneration,
  stopRequestedSince,
} from "./playback";
import { resumeAudioContext, getAudioContext } from "./context";
import {
  TriggerAudioArgs,
  PlayAudioParams,
  generatePlaybackKey,
} from "./types";
import { getCachedLoudness } from "./loudness/cache";
import { resolveGain } from "./loudness/gain";
import { exposeE2EHook } from "@/lib/testHooks";

/**
 * Type for loading state callback function
 */
export type LoadingStateCallback = (state: LoadingState) => void;

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
 * @returns The buffer *and which file it belongs to*, or null
 */
async function handleAudioFallback(
  audioFileIds: number[],
  failedAudioFileId: number,
  onStateChange?: LoadingStateCallback,
  onError?: (error: string) => void,
): Promise<{ buffer: AudioBuffer; audioFileId: number } | null> {
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
        // Which file this is matters to the caller: its gain, trim and the id
        // reported to the playback store all have to follow the substitution.
        return { buffer, audioFileId: alternativeId };
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
    return null;
  }

  // Recovery re-read the *original* file, so it keeps its own id.
  return { buffer: recoveredBuffer, audioFileId: failedAudioFileId };
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
    audioTrimSettings,
    audioGainSettings,
    padGainDb,
    isDisabled,
    onLoadingStateChange,
    onInstantFeedback,
    onAudioReady,
    onError,
  } = args;

  // A disabled pad never plays, whatever triggered it. Checked before the
  // AudioContext resume and before any user feedback so a disabled pad is
  // completely inert.
  if (isDisabled) {
    console.log(`[Audio Controls] Pad ${padIndex} is disabled, ignoring.`);
    return;
  }

  // Ensure AudioContext is active before any playback attempt
  await ensureAudioContextActive();

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
  // A fading track is on its way out, so it must not block a new trigger
  const isFadingOut = isTrackFading(playbackKey);
  const isAlreadyPlaying = isTrackPlaying(playbackKey) && !isFadingOut;

  // Get the active pad behavior from the profile store
  const activePadBehavior = useProfileStore.getState().getActivePadBehavior();

  console.log(
    `[Audio Controls] [Instant] Triggering pad ${padIndex}, key: ${playbackKey}, ` +
      `Is Playing: ${isAlreadyPlaying}, Is Fading: ${isFadingOut}, Behavior: ${activePadBehavior}, ` +
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
  } else if (isFadingOut) {
    // Hard stop the outgoing instance so the new one owns the playback key
    console.log(
      `[Audio Controls] [Instant] Stopping fading instance before re-trigger for key: ${playbackKey}`,
    );
    stopTrack(playbackKey);
  }

  // Capture the stop counters so a stop during loading cancels this trigger.
  // Re-baselined whenever this function stops a track itself, so its own
  // bookkeeping stops are never mistaken for a user-requested stop. Scoped to
  // this playback key, so stopping a *different* pad no longer cancels us.
  let triggerGeneration = getStopGeneration(playbackKey);

  try {
    // Use the strategy pattern to select which audio file to play
    const strategy = getStrategy(playbackType, playbackKey);
    const { audioFileId, index } = strategy.selectNextSound(audioFileIds);

    // Look up trim and gain for this specific audio file. Gain resolution is
    // synchronous by design — the analysis is held in memory precisely so the
    // trigger path never has to await a database read.
    // Per file rather than captured once, because the fallback path can end
    // up playing a *different* sound than the one selected: these used to be
    // computed for the file that failed and then applied to whatever the
    // fallback found, so a substituted sound played at the failed sound's
    // normalisation level and inside its trim window.
    const levelsFor = (fileId: number) => {
      const trim = audioTrimSettings?.[fileId];
      return {
        trim,
        gain: resolveGain({
          analysis: getCachedLoudness(fileId),
          trimStart: trim?.trimStart ?? 0,
          trimEnd: trim?.trimEnd,
          soundGainDb: audioGainSettings?.[fileId] ?? 0,
          padGainDb: padGainDb ?? 0,
          normalisation: useProfileStore.getState().getNormalisationSettings(),
        }),
      };
    };

    // Advance the playback strategy at most once, even if the first
    // playback attempt fails and we fall back to another method
    let strategyUpdated = false;
    const ensureStrategyUpdated = () => {
      if (!strategyUpdated) {
        strategy.updateState(index, audioFileIds);
        strategyUpdated = true;
      }
    };

    // Build playback params. Must be called after ensureStrategyUpdated so
    // the round-robin available indices reflect the sound being played.
    const buildPlayParams = (
      playingFileId: number = audioFileId,
    ): PlayAudioParams => {
      const { trim: trimForFile, gain: resolvedGain } =
        levelsFor(playingFileId);
      const playingIndex = audioFileIds.indexOf(playingFileId);

      // Resolved gain is not observable from the DOM, so E2E asserts on it
      // here. Read-only view of state the UI cannot otherwise reveal.
      exposeE2EHook("__impampLastResolvedGain", {
        playbackKey,
        audioFileId: playingFileId,
        totalDb: resolvedGain.totalDb,
        normDb: resolvedGain.normDb,
        linear: resolvedGain.linear,
        willClip: resolvedGain.willClip,
        unmeasured: resolvedGain.unmeasured,
      });

      return {
        name: name || `Pad ${padIndex + 1}`,
        padInfo: {
          profileId: activeProfileId,
          bankId: currentPageIndex,
          padIndex,
        },
        volume: resolvedGain.linear,
        trimStart: trimForFile?.trimStart,
        trimEnd: trimForFile?.trimEnd,
        multiSoundState: {
          playbackType,
          allAudioFileIds: audioFileIds,
          currentAudioFileId: playingFileId,
          currentAudioIndex: playingIndex >= 0 ? playingIndex : index,
          // Ask the strategy; the ones without a cycle answer undefined.
          availableAudioIndices: strategy.getAvailableIndices?.(),
        },
      };
    };

    // 1. Fast path: a decoded buffer is already cached (e.g. the current
    //    page has been preloaded) — play it with sample-accurate buffer
    //    playback.
    const cachedBuffer = getCachedAudioBuffer(audioFileId);
    if (cachedBuffer) {
      console.log(
        `[Audio Controls] [Instant] Playing cached buffer for ID: ${audioFileId}, pad ${padIndex}`,
      );
      audioPreloader.trackPlayedFile(audioFileId);
      ensureStrategyUpdated();
      onAudioReady?.();
      playBuffer(cachedBuffer, playbackKey, buildPlayParams());
      return;
    }

    // 2. No decoded buffer: stream directly from the stored blob via a
    //    media element. Playback starts within tens of milliseconds
    //    without decoding the whole file, and no PCM memory is held.
    try {
      const audioFileData = await getAudioFile(audioFileId);

      // Bail out if a stop was requested while the blob was being read —
      // nothing is audible yet, so just abandon the trigger
      if (stopRequestedSince(playbackKey, triggerGeneration)) {
        console.log(
          `[Audio Controls] [Instant] Blob load cancelled by a stop request for key: ${playbackKey}`,
        );
        return;
      }

      if (audioFileData?.blob) {
        ensureStrategyUpdated();
        const element = playBlobStreaming(
          audioFileData.blob,
          playbackKey,
          buildPlayParams(),
        );
        if (element) {
          const playable = await waitForStreamingPlayable(element);

          // A stop (ESC, or a re-trigger of this pad) during the wait tears
          // this element down and takes the playback key away from it.
          // Never continue in that case — falling through to the decode
          // path would restart the sound the user just stopped. A media
          // error also drops ownership, but without bumping the stop
          // generation, so unsupported formats still fall back to decoding.
          const active = getActiveTrack(playbackKey);
          const stillOurs =
            active?.source.kind === "media" &&
            active.source.element === element;
          if (
            !stillOurs &&
            stopRequestedSince(playbackKey, triggerGeneration)
          ) {
            console.log(
              `[Audio Controls] [Instant] Streaming start cancelled by a stop request for key: ${playbackKey}`,
            );
            return;
          }

          if (playable) {
            console.log(
              `[Audio Controls] [Instant] Streaming audio file ID: ${audioFileId} for pad ${padIndex}`,
            );
            audioPreloader.trackPlayedFile(audioFileId);
            onAudioReady?.();
            return;
          }
          // Release the failed streaming attempt (no-op if the element's
          // error handler already cleaned it up). This is our own stop, so
          // re-baseline the generation to keep the decode fallback alive.
          stopTrack(playbackKey);
          triggerGeneration = getStopGeneration(playbackKey);
        }
        console.warn(
          `[Audio Controls] [Instant] Streaming start failed for ID: ${audioFileId}, falling back to decode...`,
        );
      } else {
        console.warn(
          `[Audio Controls] [Instant] Audio file ID ${audioFileId} not found for streaming, falling back to decode...`,
        );
      }
    } catch (streamError) {
      console.warn(
        `[Audio Controls] [Instant] Streaming playback error for ID: ${audioFileId}, falling back to decode:`,
        streamError,
      );
    }

    // 3. Fallback: decode the full file (also covers edge cases the media
    //    element pipeline can't stream but decodeAudioData can handle)
    let buffer = await loadAndDecodeAudioInstant(
      audioFileId,
      onLoadingStateChange,
    );
    // Which sound ends up playing. Normally the one the strategy chose; the
    // fallback path below can change it.
    let playingFileId = audioFileId;

    // If primary loading failed, attempt fallback and recovery
    if (!buffer) {
      console.warn(
        `[Audio Controls] [Instant] Primary load failed for ID: ${audioFileId}, attempting fallback...`,
      );

      const fallback = await handleAudioFallback(
        audioFileIds,
        audioFileId,
        onLoadingStateChange,
        onError,
      );
      if (fallback) {
        buffer = fallback.buffer;
        // The substitute is what plays, so it is what the levels, the trim
        // window and the id reported to the playback store must describe.
        playingFileId = fallback.audioFileId;
      }
    }

    // Bail out if a stop was requested while we were loading
    if (stopRequestedSince(playbackKey, triggerGeneration)) {
      console.log(
        `[Audio Controls] [Instant] Load cancelled by a stop request for key: ${playbackKey}`,
      );
      return;
    }

    if (buffer) {
      // Track this file as recently played for intelligent preloading
      audioPreloader.trackPlayedFile(playingFileId);

      console.log(
        `[Audio Controls] [Instant] Playing audio file ID: ${playingFileId} for pad ${padIndex}`,
      );

      ensureStrategyUpdated();

      // Notify that audio is ready and starting
      onAudioReady?.();

      // Play the buffer with the appropriate parameters
      playBuffer(buffer, playbackKey, buildPlayParams(playingFileId));
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
 * Intelligent preloading for current page with priority-based loading
 *
 * @param padConfigs - Array of pad configurations for the current page
 * @param profileId - ID of the active profile
 * @param bankId - Identity of the current bank
 */
export function preloadCurrentPageIntelligent(
  padConfigs: PadConfiguration[],
  profileId: number,
  bankId: string,
): void {
  audioPreloader.preloadCurrentPage(padConfigs, profileId, bankId);
}

/**
 * Preload files on hover for anticipatory loading
 *
 * @param audioFileIds - Audio file IDs to preload
 * @param context - Context information for the preload
 */
export function preloadOnHover(
  audioFileIds: number[],
  context: { profileId: number; bankId: string; padIndex: number },
): void {
  audioPreloader.preloadOnHover(audioFileIds, context);
}

/**
 * Preload the sounds of a track that was just armed, so firing the cue hits
 * the cached-buffer fast path instead of loading on the spot
 *
 * @param audioFileIds - Audio file IDs of the armed pad
 * @param context - Context information for the preload
 */
export function preloadArmedTrack(
  audioFileIds: number[],
  context: { profileId: number; bankId: string; padIndex: number },
): void {
  audioPreloader.preloadArmedTrack(audioFileIds, context);
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
