/**
 * Hook for track control operations
 *
 * Provides functions for controlling audio tracks (stop, fadeout, etc.)
 * that can be reused across different components.
 *
 * @module hooks/useTrackControls
 */

import {
  stopAudio,
  fadeOutAudio,
  stopAllAudio,
  fadeOutAllAudio,
} from "@/lib/audio";
import { isAudioPlaying, isAudioFading } from "@/lib/audio/controls";
import { useProfileStore } from "@/store/profileStore";

/**
 * Custom hook that provides track control functions
 */
export function useTrackControls() {
  // Get fadeout duration from profile store
  const getFadeoutDuration = useProfileStore(
    (state) => state.getFadeoutDuration,
  );

  return {
    /**
     * Stop a track immediately
     *
     * @param key - The playback key of the track to stop
     */
    stopTrack: (key: string) => {
      console.log(`[Track Controls] Stopping track: ${key}`);
      stopAudio(key);
    },

    /**
     * Fade out a track using the current profile's fadeout duration
     *
     * @param key - The playback key of the track to fade out
     */
    fadeOutTrack: (key: string) => {
      const duration = getFadeoutDuration();
      console.log(
        `[Track Controls] Fading out track: ${key} over ${duration}s`,
      );
      fadeOutAudio(key, duration);
    },

    /**
     * Fade out a track with a specific duration
     *
     * @param key - The playback key of the track to fade out
     * @param duration - The duration of the fadeout in seconds
     */
    fadeOutTrackWithDuration: (key: string, duration: number) => {
      console.log(
        `[Track Controls] Fading out track: ${key} over ${duration}s`,
      );
      fadeOutAudio(key, duration);
    },

    /**
     * Stop all currently playing tracks
     */
    stopAllTracks: () => {
      console.log(`[Track Controls] Stopping all tracks`);
      stopAllAudio();
    },

    /**
     * Fade out all currently playing tracks
     *
     * @param duration - Optional custom duration, otherwise uses profile setting
     */
    fadeOutAllTracks: (duration?: number) => {
      const fadeDuration = duration || getFadeoutDuration();
      console.log(
        `[Track Controls] Fading out all tracks over ${fadeDuration}s`,
      );
      fadeOutAllAudio(fadeDuration);
    },

    /**
     * Check if a track is currently playing
     *
     * @param key - The playback key to check
     * @returns True if the track is playing
     */
    isTrackPlaying: (key: string): boolean => {
      return isAudioPlaying(key);
    },

    /**
     * Check if a track is currently fading out
     *
     * @param key - The playback key to check
     * @returns True if the track is fading
     */
    isTrackFading: (key: string): boolean => {
      return isAudioFading(key);
    },

    /**
     * Get the current fadeout duration from the profile
     *
     * @returns Fadeout duration in seconds
     */
    getFadeoutDuration: () => getFadeoutDuration(),
  };
}
