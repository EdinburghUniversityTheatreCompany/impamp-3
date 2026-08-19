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
  currentBankId: string;
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
 * cleared however the trigger ends — a pad left in its loading state is the
 * failure mode the three hand-written copies each had to remember to avoid.
 *
 * "However it ends" is the part that took a second go. Clearing on
 * `onAudioReady` and `onError` covers played and failed, but not cancelled:
 * `triggerAudioForPadInstant` abandons a trigger whose pad was stopped while
 * it was loading, and calls neither callback, because nothing became audible
 * and nothing went wrong. Pressing ESC during a slow load therefore left the
 * spinner up — and with a leftover status of "ready" the overlay shows no
 * label either, just a spinner over a full progress bar, until that pad is
 * next triggered successfully.
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
  const { activeProfileId, currentBankId } = context;
  const { logPrefix = "[Trigger]" } = options;

  const loadingKey = generatePadLoadingKey(
    activeProfileId,
    currentBankId,
    pad.padIndex,
  );
  const clearLoading = () =>
    loadingStoreActions.clearPadLoadingState(loadingKey);

  try {
    await triggerAudioForPadInstant({
      padIndex: pad.padIndex,
      audioFileIds: pad.audioFileIds,
      playbackType: pad.playbackType,
      activeProfileId,
      currentBankId,
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
  } finally {
    // Every terminal outcome wants the overlay gone — played, failed, or
    // cancelled by a stop. Clearing a key that is already clear is a no-op,
    // so the callbacks above stay as the thing that clears it *promptly*,
    // and this is only what catches the outcomes they do not describe.
    clearLoading();
  }
}
