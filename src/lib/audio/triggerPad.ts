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
  useLoadingStore,
} from "@/store/loadingStore";
import { noticeActions } from "@/store/noticeStore";
import type { LoadingState } from "./decoder";
import type { PadPlaybackSettings } from "@/lib/db";

/**
 * How long a pad stays in its error state before clearing itself.
 *
 * Long enough to be seen on a board the operator is looking at, short enough
 * that a pad is not still red at the next cue. The notice carries the reason
 * and stays until dismissed; the overlay only has to say *which* pad.
 */
export const ERROR_OVERLAY_MS = 4000;

/**
 * Everything about the pad that decides what is played and how loudly, plus
 * where on the grid it sits.
 *
 * The playback half is `PadPlaybackSettings` itself rather than a copy of its
 * members, and `triggerPad` forwards it with a spread rather than naming the
 * fields one at a time. Both halves of that matter, and the second is the one
 * that bites: every caller builds its argument by spreading
 * `extractPadPlaybackSettings(pad)` into an object literal, and TypeScript
 * exempts spread-in properties from excess-property checking — so a field this
 * interface failed to declare, or one an enumeration failed to copy, went
 * missing with no compiler error at either point. That is exactly how
 * `activePadBehavior` came to reach the engine from three paths and not the
 * fourth. Extending the type is what makes the first omission impossible;
 * spreading the value is what makes the second one impossible.
 */
export interface TriggerablePad extends PadPlaybackSettings {
  padIndex: number;
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
 * A failure is the one ending that does *not* clear at once. `Pad.tsx` had
 * rendered an `"error"` status since the overlay was written and nothing
 * ever set it, because `onError` cleared the key in the same breath — so a
 * press whose sound could not be loaded looked exactly like a press nobody
 * made. The pad now holds the error state for `ERROR_OVERLAY_MS`, and the
 * reason goes to the notice stack, where it stays until dismissed.
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
      // Spread, never enumerated — see `TriggerablePad`. The context and the
      // callbacks are written after it so they win over anything a caller
      // happens to carry under the same name.
      ...pad,
      activeProfileId,
      currentBankId,
      onInstantFeedback: options.onInstantFeedback,
      onLoadingStateChange: (state: LoadingState) => {
        loadingStoreActions.setPadLoadingState(loadingKey, state);
      },
      onAudioReady: clearLoading,
      onError: (error: string) => {
        console.error(`${logPrefix} pad ${pad.padIndex}:`, error);
        markFailed(loadingKey, error);
        noticeActions.error(
          `Could not play ${pad.name || `pad ${pad.padIndex + 1}`}: ${error}`,
        );
        options.onError?.(error);
      },
    });
  } finally {
    // Every terminal outcome but one wants the overlay gone — played, or
    // cancelled by a stop. Clearing a key that is already clear is a no-op,
    // so the callbacks above stay as the thing that clears it *promptly*,
    // and this is only what catches the outcomes they do not describe. The
    // exception is a failure: `markFailed` has just written the error state
    // and owns its clearing, and wiping it here is exactly what left a failed
    // press indistinguishable from a press nobody made.
    if (currentState(loadingKey)?.status !== "error") clearLoading();
  }
}

const currentState = (loadingKey: string): LoadingState | undefined =>
  useLoadingStore.getState().padLoadingStates.get(loadingKey);

/**
 * Puts the pad in its error state and clears it again after
 * `ERROR_OVERLAY_MS` — but only if the state is still the one written here.
 * A press in the meantime has replaced it with a loading state of its own,
 * and that must not be wiped by the timer of the press before it.
 */
function markFailed(loadingKey: string, error: string): void {
  const previous = currentState(loadingKey);
  const failed: LoadingState = {
    audioFileId: previous?.audioFileId,
    status: "error",
    error,
    startTime: previous?.startTime ?? performance.now(),
  };
  loadingStoreActions.setPadLoadingState(loadingKey, failed);
  setTimeout(() => {
    if (currentState(loadingKey) === failed) {
      loadingStoreActions.clearPadLoadingState(loadingKey);
    }
  }, ERROR_OVERLAY_MS);
}
