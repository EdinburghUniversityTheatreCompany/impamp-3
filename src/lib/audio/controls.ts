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
import { loadAndDecodeAudio, preloadAudioFiles } from "./decoder";
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
import { resumeAudioContext } from "./context";
import { TriggerAudioArgs, generatePlaybackKey } from "./types";

/**
 * Triggers audio playback for a pad
 *
 * Handles the user interaction to play a pad's audio.
 * Checks activePadBehavior, selects the correct audio file based on playbackType,
 * loads audio if needed, and plays it.
 *
 * @param args - Configuration for triggering audio
 * @returns Promise that resolves when audio playback has been triggered (or failed)
 */
export async function triggerAudioForPad(
  args: TriggerAudioArgs,
): Promise<void> {
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
      `[Audio Controls] Pad ${padIndex} has no audio files configured.`,
    );
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
    `[Audio Controls] Triggering pad ${padIndex}, key: ${playbackKey}, ` +
      `Is Playing: ${isAlreadyPlaying}, Behavior: ${activePadBehavior}, ` +
      `Playback Type: ${playbackType}, Audio Files: ${audioFileIds.length}`,
  );

  // Handle behavior if the track is already playing
  if (isAlreadyPlaying) {
    switch (activePadBehavior) {
      case "continue":
        console.log(
          `[Audio Controls] Behavior=continue. Doing nothing for key: ${playbackKey}`,
        );
        return; // Do nothing

      case "stop":
        console.log(
          `[Audio Controls] Behavior=stop. Stopping key: ${playbackKey}`,
        );
        stopTrack(playbackKey); // Stop the existing sound
        return; // Don't proceed to play again

      case "restart":
        console.log(
          `[Audio Controls] Behavior=restart. Handling restart for key: ${playbackKey}`,
        );
        // Stop first, then continue to play again (fall through)
        stopTrack(playbackKey);
        break; // Continue to play the sound again

      default:
        console.warn(
          `[Audio Controls] Unknown activePadBehavior: ${activePadBehavior}. Defaulting to 'continue'.`,
        );
        return; // Default to continue
    }
  }

  try {
    // Use the strategy pattern to select which audio file to play
    const strategy = getStrategy(playbackType);
    const { audioFileId, index } = strategy.selectNextSound(audioFileIds);

    // Load and decode the selected audio buffer
    const buffer = await loadAndDecodeAudio(audioFileId);

    if (buffer) {
      // Play the buffer
      console.log(
        `[Audio Controls] Playing audio file ID: ${audioFileId} for pad ${padIndex}`,
      );

      // Update strategy state after selection (important for round-robin and sequential)
      strategy.updateState(index, audioFileIds);

      // Play the buffer with the appropriate parameters
      playBuffer(buffer, playbackKey, {
        name: name || `Pad ${padIndex + 1}`, // Use provided name or fallback
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
          // For round-robin, we might need to get available indices from the strategy
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
      console.error(
        `[Audio Controls] Failed to load audio file ID: ${audioFileId} for pad ${padIndex}`,
      );
    }
  } catch (error) {
    console.error(
      `[Audio Controls] Error triggering audio for pad ${padIndex}:`,
      error,
    );
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
 * Preloads audio for a collection of pad configurations
 *
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
    `[Audio Controls] Preloading ${uniqueIds.length} audio files for the current page...`,
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
