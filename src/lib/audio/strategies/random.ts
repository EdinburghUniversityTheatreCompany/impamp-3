/**
 * Audio Module - Random Playback Strategy
 *
 * Implements the PlaybackStrategy interface for random playback mode.
 * Selects a random sound from the collection each time.
 *
 * @module lib/audio/strategies/random
 */

import { PlaybackStrategy } from "../types";

/**
 * Random playback strategy class
 *
 * Selects a random sound from the available audio files each time it's triggered.
 * No memory of previously played sounds is maintained.
 */
export class RandomStrategy implements PlaybackStrategy {
  /**
   * Selects a random sound from the array
   *
   * @param audioFileIds - Array of available audio file IDs
   * @returns Object containing the randomly selected audioFileId and its index
   */
  selectNextSound(audioFileIds: number[]): {
    audioFileId: number;
    index: number;
  } {
    if (audioFileIds.length === 0) {
      throw new Error("Cannot select a sound from an empty array");
    }

    // Generate a random index within the array bounds
    const index = Math.floor(Math.random() * audioFileIds.length);
    const audioFileId = audioFileIds[index];

    return { audioFileId, index };
  }

  /**
   * Updates the internal state
   *
   * For random strategy, there is no state to update since each selection is independent
   *
   * @param playedIndex - Index of the sound that was just played (unused)
   * @param audioFileIds - Array of all available audio file IDs (unused)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updateState(playedIndex: number, audioFileIds: number[]): void {
    // No state to update for random strategy
    // Each selection is independent of previous selections
  }
}
