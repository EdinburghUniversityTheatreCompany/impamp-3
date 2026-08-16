/**
 * Triggering a pad, with its loading state wired up.
 *
 * `triggerAudioForPadInstant` takes four callbacks, and three call sites —
 * `usePadInteractions`, the search modal and the armed-track player in
 * `playbackStore` — each built the same four by hand, each recomputing
 * `generatePadLoadingKey(profileId, pageIndex, padIndex)` inside every one of
 * them. Twelve copies of the same three-argument call, spread across a hook, a
 * component and a Zustand store, so a change to how loading is reported had to
 * be made in three unrelated places. They had already drifted in their log
 * prefixes and in whether they awaited.
 *
 * @module lib/audio/triggerPad
 */

import { triggerAudioForPadInstant } from "./controls";
import {
  generatePadLoadingKey,
  loadingStoreActions,
} from "@/store/loadingStore";
import type { LoadingState } from "./decoder";
import type { PlaybackType } from "@/lib/db";

/** Everything about the pad that decides what is played and how loudly. */
export interface TriggerablePad {
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  name?: string;
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
  isDisabled?: boolean;
}

/** Where the pad lives, which is what the loading key is built from. */
export interface TriggerContext {
  activeProfileId: number;
  currentPageIndex: number;
}

export interface TriggerPadOptions {
  /** Fires before any loading starts, for immediate visual feedback. */
  onInstantFeedback?: () => void;
  /** Anything that stopped it playing, already a sentence. */
  onError?: (error: string) => void;
  /** Prefix for this call site's console output. */
  logPrefix?: string;
}

/**
 * Plays a pad, keeping the shared loading state in step.
 *
 * The loading key is computed once here rather than in each callback, and
 * cleared on both success and failure — a pad left in its loading state after
 * an error is the failure mode the three hand-written copies each had to
 * remember to avoid.
 *
 * @param pad - What to play
 * @param context - The profile and bank it belongs to
 * @param options - Per-call-site extras
 */
export async function triggerPad(
  pad: TriggerablePad,
  context: TriggerContext,
  options: TriggerPadOptions = {},
): Promise<void> {
  const { activeProfileId, currentPageIndex } = context;
  const { logPrefix = "[Trigger]" } = options;

  const loadingKey = generatePadLoadingKey(
    activeProfileId,
    currentPageIndex,
    pad.padIndex,
  );
  const clearLoading = () =>
    loadingStoreActions.clearPadLoadingState(loadingKey);

  await triggerAudioForPadInstant({
    padIndex: pad.padIndex,
    audioFileIds: pad.audioFileIds,
    playbackType: pad.playbackType,
    activeProfileId,
    currentPageIndex,
    name: pad.name,
    audioTrimSettings: pad.audioTrimSettings,
    audioGainSettings: pad.audioGainSettings,
    padGainDb: pad.padGainDb,
    isDisabled: pad.isDisabled,
    onInstantFeedback: options.onInstantFeedback,
    onLoadingStateChange: (state: LoadingState) => {
      loadingStoreActions.setPadLoadingState(loadingKey, state);
    },
    onAudioReady: clearLoading,
    onError: (error: string) => {
      console.error(`${logPrefix} pad ${pad.padIndex}:`, error);
      clearLoading();
      options.onError?.(error);
    },
  });
}
