/**
 * Audio Module - Types
 *
 * Common types and interfaces for the audio module.
 * Defines the strategy pattern interfaces for different playback types.
 *
 * @module lib/audio/types
 */

import { PlaybackType } from "../db";

/**
 * Playback strategy interface for implementing different audio selection strategies
 * (sequential, random, round-robin)
 */
export interface PlaybackStrategy {
  /**
   * Selects the next sound to play from the array of available audio file IDs
   *
   * @param audioFileIds - Array of available audio file IDs
   * @returns Object containing the selected audioFileId and its index in the array
   */
  selectNextSound(audioFileIds: number[]): {
    audioFileId: number;
    index: number;
  };

  /**
   * Updates the internal state of the strategy after a sound has been played
   *
   * @param playedIndex - Index of the sound that was just played
   * @param audioFileIds - Array of all available audio file IDs
   */
  updateState(playedIndex: number, audioFileIds: number[]): void;
}

/**
 * Represents a currently playing audio track
 */
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
  // Multi-sound state
  playbackType: PlaybackType;
  allAudioFileIds: number[]; // The full list for this pad
  currentAudioFileId: number; // The specific ID currently playing
  currentAudioIndex?: number; // Index within allAudioFileIds
  availableAudioIndices?: number[]; // Remaining indices for round-robin
}

/**
 * Arguments for triggering audio playback
 */
export interface TriggerAudioArgs {
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  activeProfileId: number;
  currentPageIndex: number;
  name?: string;
}

/**
 * Parameters for creating and playing an audio source
 */
export interface PlayAudioParams {
  name: string;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
  volume?: number;
  multiSoundState: {
    playbackType: PlaybackType;
    allAudioFileIds: number[];
    currentAudioFileId: number;
    currentAudioIndex?: number;
    availableAudioIndices?: number[];
  };
}

/**
 * Helper for generating playback keys in a consistent format
 *
 * @param profileId - Profile ID
 * @param pageIndex - Page/bank index
 * @param padIndex - Pad index
 * @returns Formatted playback key string
 */
export function generatePlaybackKey(
  profileId: number,
  pageIndex: number,
  padIndex: number,
): string {
  return `pad-${profileId}-${pageIndex}-${padIndex}`;
}
