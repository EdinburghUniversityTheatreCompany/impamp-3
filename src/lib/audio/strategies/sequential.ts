/**
 * Audio Module - Sequential Playback Strategy
 *
 * Implements the PlaybackStrategy interface for sequential playback mode.
 * Plays sounds in order and cycles back to the beginning after reaching the end.
 *
 * @module lib/audio/strategies/sequential
 */

import { PlaybackStrategy } from "../types";

/**
 * Sequential playback strategy class
 *
 * Plays sounds in order, starting from the first and cycling back to the beginning
 * after reaching the end of the list.
 */
export class SequentialStrategy implements PlaybackStrategy {
  private nextIndex: number = 0;

  /**
   * Selects the next sound to play in the sequence
   *
   * @param audioFileIds - Array of available audio file IDs
   * @returns Object containing the selected audioFileId and its index
   */
  selectNextSound(audioFileIds: number[]): {
    audioFileId: number;
    index: number;
  } {
    if (audioFileIds.length === 0) {
      throw new Error("Cannot select a sound from an empty array");
    }

    // Ensure the index is within bounds (in case the array size changed)
    if (this.nextIndex >= audioFileIds.length) {
      this.nextIndex = 0;
    }

    const index = this.nextIndex;
    const audioFileId = audioFileIds[index];

    return { audioFileId, index };
  }

  /**
   * Updates the internal state to prepare for the next selection
   *
   * @param playedIndex - Index of the sound that was just played
   * @param audioFileIds - Array of all available audio file IDs
   */
  updateState(playedIndex: number, audioFileIds: number[]): void {
    // Calculate the next index, cycling back to 0 if we reach the end
    this.nextIndex = (playedIndex + 1) % audioFileIds.length;
  }

  /**
   * Resets the strategy state back to the beginning of the sequence
   */
  reset(): void {
    this.nextIndex = 0;
  }
}
