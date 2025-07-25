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
  triggerAudioForPadInstant,
  stopAudio,
  fadeOutAudio,
  stopAllAudio,
  fadeOutAllAudio,
  isAudioPlaying,
  isAudioFading,
  ensureAudioContextActive,
  preloadCurrentPageIntelligent,
  preloadOnHover,
  preloadAllConfiguredFiles,
  getPreloadingStats,
} from "./controls";

// Re-export preloader for direct access
export { audioPreloader } from "./preloader";

// Re-export type definitions that are needed by other modules
export { generatePlaybackKey } from "./types";
export type { TriggerAudioArgs } from "./types";
export type { TriggerAudioArgsEnhanced } from "./controls";
export type { LoadingState } from "./decoder";

/**
 * Audio Module Version
 * Update this when making significant changes to the audio module
 */
export const AUDIO_MODULE_VERSION = "1.0.0";
