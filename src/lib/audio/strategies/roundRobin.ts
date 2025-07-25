/**
 * Audio Module - Round Robin Playback Strategy
 *
 * Implements the PlaybackStrategy interface for round-robin playback mode.
 * Plays sounds in random order without repeating until all have been played.
 *
 * @module lib/audio/strategies/roundRobin
 */

import { PlaybackStrategy } from "../types";

/**
 * Round Robin playback strategy class
 *
 * Plays all sounds in the collection in a random order without repeating
 * until all have been played, then resets and starts a new random sequence.
 */
export class RoundRobinStrategy implements PlaybackStrategy {
  private availableIndices: number[] = [];

  /**
   * Selects the next sound to play using round-robin logic
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

    // If available indices is empty or no longer matches the input array,
    // reset it with all indices from the input array
    if (
      this.availableIndices.length === 0 ||
      !this.isValidForArray(audioFileIds.length)
    ) {
      this.resetAvailableIndices(audioFileIds.length);
    }

    // Pick a random position from the available indices
    const randomPosition = Math.floor(
      Math.random() * this.availableIndices.length,
    );

    // Get the actual index from the available indices array
    const index = this.availableIndices[randomPosition];

    // Remove the selected index from the available indices
    this.availableIndices.splice(randomPosition, 1);

    // Get the corresponding audio file ID
    const audioFileId = audioFileIds[index];

    return { audioFileId, index };
  }

  /**
   * Updates the internal state after a sound has been played
   *
   * @param playedIndex - Index of the sound that was just played (unused in this implementation)
   * @param audioFileIds - Array of all available audio file IDs
   */

  updateState(playedIndex: number, audioFileIds: number[]): void {
    // If all sounds have been played, reset the available indices
    if (this.availableIndices.length === 0) {
      this.resetAvailableIndices(audioFileIds.length);
    }
  }

  /**
   * Checks if the current available indices are valid for the given array length
   *
   * @param arrayLength - Length of the current audioFileIds array
   * @returns True if the current state is valid for the array length
   */
  private isValidForArray(arrayLength: number): boolean {
    // Check if any available index is out of bounds for the current array
    return !this.availableIndices.some((index) => index >= arrayLength);
  }

  /**
   * Resets the available indices to include all indices in the array
   *
   * @param length - Length of the audioFileIds array
   */
  private resetAvailableIndices(length: number): void {
    this.availableIndices = Array.from({ length }, (_, i) => i);
  }

  /**
   * Gets the current available indices (for state tracking)
   *
   * @returns Array of indices that haven't been played yet in this cycle
   */
  getAvailableIndices(): number[] {
    return [...this.availableIndices];
  }
}
