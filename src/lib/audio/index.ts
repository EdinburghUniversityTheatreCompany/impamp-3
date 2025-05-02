/**
 * Audio Module - Main Entry Point
 *
 * Public API for the audio module.
 * Exposes only the functions that should be used by other modules.
 *
 * @module lib/audio
 */

// Re-export public functions from controls.ts
export {
  triggerAudioForPad,
  stopAudio,
  fadeOutAudio,
  stopAllAudio,
  fadeOutAllAudio,
  isAudioPlaying,
  isAudioFading,
  ensureAudioContextActive,
  preloadAudioForPage,
} from "./controls";

// Re-export type definitions that are needed by other modules
export { generatePlaybackKey } from "./types";
export type { TriggerAudioArgs } from "./types";

/**
 * Audio Module Version
 * Update this when making significant changes to the audio module
 */
export const AUDIO_MODULE_VERSION = "1.0.0";
