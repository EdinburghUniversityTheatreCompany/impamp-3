import { useEffect, useCallback, useRef } from "react";
import { useProfileStore } from "@/store/profileStore";
import { extractPadPlaybackSettings, PadConfiguration } from "@/lib/db";
import {
  EmergencySound,
  hasLoadedEmergencySounds,
  reloadEmergencySounds,
  takeNextEmergencySound,
} from "@/hooks/emergencySounds";
import {
  ensureAudioContextActive,
  stopAllAudio,
  fadeOutAllAudio,
  triggerPad,
} from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { useSearchContext } from "@/components/search";
import { useUIStore } from "@/store/uiStore";
import { isControlActivationKey, getPadIndexForKey } from "@/lib/keyboardUtils";
import { openHelpModal } from "@/lib/uiUtils";
import {
  usePadConfigurations,
  actionablePadConfigs,
} from "@/hooks/usePadConfigurations";
import { useIsAnyOverlayOpen } from "@/hooks/useIsAnyOverlayOpen";

// Debounce map to prevent rapid re-triggering
const keyDebounceMap = new Map<string, boolean>();
const DEBOUNCE_TIME_MS = 100; // Adjust as needed

/**
 * Plays one emergency cue.
 *
 * Through `triggerPad`, like every other trigger in the app: this used to
 * build `triggerAudioForPadInstant`'s four callbacks by hand, recomputing the
 * loading key inside three of them, and so carried its own answer to what
 * happens when a trigger is cancelled mid-load.
 *
 * `sound` is passed whole rather than field by field. `EmergencySound` is
 * `TriggerablePad` plus the profile and bank it lives on, and enumerating that
 * overlap is exactly how a field comes to be dropped in silence — TypeScript
 * exempts a spread from excess-property checking.
 */
async function playEmergencySound(sound: EmergencySound): Promise<void> {
  // Check for valid audioFileIds array
  if (!sound || !sound.audioFileIds || sound.audioFileIds.length === 0) {
    console.error(
      "[KeyboardListener] Invalid or empty emergency sound configuration:",
      sound,
    );
    return;
  }

  console.log(
    `[KeyboardListener] Triggering emergency sound: Pad ${sound.padIndex}, AudioIDs: ${sound.audioFileIds.join(",")}`,
  );

  await triggerPad(
    sound,
    { activeProfileId: sound.profileId, currentBankId: sound.bankId },
    { logPrefix: "[KeyboardListener] emergency sound" },
  );
}

export function useKeyboardListener() {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // The identity of the bank on screen, straight from the store. This used to
  // be derived as `String(currentPageIndex)` — exact only for a migrated
  // bank, whose id is its position by construction. A bank created after the
  // migration (or one that arrived from a JSON import or a sync carrying an
  // explicit, non-positional `bankId` — both accepted today) has a
  // `crypto.randomUUID()` id, so that bridge either matched nothing (every
  // keyboard shortcut silently dead on that bank) or matched a *different*
  // migrated bank still holding that numeric id (firing the wrong pads).
  const currentBankId = useProfileStore((state) => state.currentBankId);
  const setCurrentPageIndex = useProfileStore(
    (state) => state.setCurrentPageIndex,
  );
  // Get edit mode states and setters from store
  const setEditMode = useProfileStore((state) => state.setEditMode);
  // The emergency set is a cached copy of pad data, so it is invalidated by
  // the counter every other copy uses. It had one of its own, bumped only by
  // the local edit paths, so a bank a sync changed never reached the Enter key.
  const padConfigsVersion = useProfileStore((state) => state.padConfigsVersion);

  // Get search context
  const { openSearchModal, isSearchModalOpen } = useSearchContext();
  // Get modal state and actions from UI store individually to prevent unnecessary re-renders
  const isModalOpen = useUIStore((state) => state.isModalOpen);
  // Everything that should own the keyboard while it is up — including the
  // profile manager, which is rendered outside the modal system and so was
  // missed by the `isModalOpen` guard below.
  const isAnyOverlayOpen = useIsAnyOverlayOpen();
  const modalConfig = useUIStore((state) => state.modalConfig);

  const hasInteracted = useRef(false); // Track interaction for AudioContext resume

  // Whether whatever holds focus was put there by Tab rather than by a
  // pointer. It is what decides if a focused control may keep Enter and Space
  // for itself, so it is tracked explicitly rather than asked of the browser:
  // `:focus-visible` answers the same question and answers it wrong here,
  // flipping a click-focused button to focus-visible on the very keydown
  // being judged.
  //
  // Its own capture-phase listeners, not a branch of `handleKeyDown`, because
  // that handler stands down for overlays and text fields — and a Tab pressed
  // inside a text field still moves focus.
  const focusReachedByTabRef = useRef(false);
  useEffect(() => {
    const noteTab = (event: KeyboardEvent) => {
      if (event.key === "Tab") focusReachedByTabRef.current = true;
    };
    const notePointer = () => {
      focusReachedByTabRef.current = false;
    };
    window.addEventListener("keydown", noteTab, { capture: true });
    window.addEventListener("pointerdown", notePointer, { capture: true });
    return () => {
      window.removeEventListener("keydown", noteTab, { capture: true });
      window.removeEventListener("pointerdown", notePointer, { capture: true });
    };
  }, []);

  // The pad configurations for the active page, from the same hook the grid
  // uses. This used to be a second, private fetch into a ref — the old comment
  // here said "might be inefficient if PadGrid already has them, consider
  // passing configs down", and the cost turned out to be worse than
  // inefficiency: the two copies had different invalidation rules, so a write
  // path could refresh the grid's and not this one, leaving pads you could see
  // but not play until you switched bank.
  //
  // Held in a ref as well as read from the hook so `handleKeyDown` does not
  // have to be rebuilt (and the window listeners re-attached) on every change.
  const { padConfigs, isLoading: isLoadingConfigs } = usePadConfigurations(
    activeProfileId === null ? null : String(activeProfileId),
    currentBankId,
  );
  const padConfigsRef = useRef<Map<number, PadConfiguration>>(padConfigs);
  useEffect(() => {
    padConfigsRef.current = actionablePadConfigs(padConfigs, isLoadingConfigs);
  }, [padConfigs, isLoadingConfigs]);

  // Track whether edit mode was entered by holding Shift (vs. the toolbar button)
  const editModeFromShiftRef = useRef(false);

  // Effect to load emergency sounds when the profile changes, or when anything
  // has written pad configurations or page metadata — locally or via sync.
  useEffect(() => {
    console.log(`Loading emergency sounds (version: ${padConfigsVersion})`);
    void reloadEmergencySounds(activeProfileId);
  }, [activeProfileId, padConfigsVersion]);

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      // Ignore OS auto-repeat; every shortcut here is a discrete action
      if (event.repeat) return;

      // --- Ctrl+S to Confirm Modal ---
      // IMPORTANT: This must come BEFORE the input/textarea check
      if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); // Never hand this to the browser's save dialog
        if (isModalOpen) {
          console.log(
            "[KeyboardListener] Ctrl+S detected: Modal open. Attempting confirm.",
          );
          try {
            // The confirm handler owns closing the modal, exactly as it does
            // when the confirm button is clicked, so failed validation keeps
            // the modal (and the user's edits) open.
            await modalConfig?.onConfirm?.();
          } catch (error) {
            console.error(
              "[KeyboardListener] Error during modal confirm on Ctrl+S:",
              error,
            );
          }
        }
        return; // Stop further processing
      }

      // While anything is open on top it owns the keyboard (Escape, Tab,
      // typing, etc.). This used to ask only about the modal system, so the
      // profile manager — rendered outside it — left every pad key, bank key,
      // Enter and Escape live behind the overlay.
      if (isAnyOverlayOpen) {
        return;
      }

      // Ignore other keys if typing in an input field, textarea, etc.
      // (but allow Ctrl+S handled above)
      const targetElement = event.target as HTMLElement;
      if (
        targetElement.tagName === "INPUT" ||
        targetElement.tagName === "TEXTAREA" ||
        targetElement.isContentEditable
      ) {
        console.log("[KeyboardListener] Ignoring key press in input/textarea.");
        return;
      }

      // If something upstream already claimed this key, it is not ours.
      // Every shortcut below fires regardless of focus, on the assumption
      // that nothing nearer the target wanted the key; `defaultPrevented` is
      // the DOM saying otherwise, and acting anyway runs two commands off one
      // press.
      //
      // `@hello-pangea/dnd` drives a bank-tab drag from a `window` keydown
      // listener bound with `{capture: true}`, so it preventDefaults before
      // this bubble-phase one: Escape to cancel, Space to drop, Enter via
      // `preventStandardKeyEvents` (dnd.cjs.js:4957, :5227, :5320). Each was
      // a live bug — Escape mid-drag hit the panic button and hard-stopped
      // every sound in the room.
      //
      // Below the early-outs rather than at the top of the handler, because
      // Ctrl+S must stay live behind an overlay. Covering Ctrl+F as well is
      // deliberate and inert: dnd never claims "f".
      if (event.defaultPrevented) {
        return;
      }

      // Tab is deliberately *not* suppressed here any more.
      //
      // It used to be — `event.preventDefault(); return;` for every Tab
      // outside an input or an overlay — so that a stray Tab mid-show could
      // not walk focus onto a pad, where Enter and Space would then fire that
      // pad instead of the emergency bank and Fade Out All. The cost was that
      // Search, Help, the mode toggles, the bank tabs and the profile
      // selector could not be reached without a mouse at all.
      //
      // The two halves are now separated. `Pad` carries `tabIndex={-1}`, so
      // Tab walks the chrome and can never land on the board; and the guard
      // below hands Enter and Space to a control only when the operator
      // tabbed to it, so a pointer click still leaves both keys with the
      // transport. Escape blurs, so panic is also the way back to the
      // instrument.
      if (
        focusReachedByTabRef.current &&
        isControlActivationKey(event.key, event.target)
      ) {
        console.log(
          "[KeyboardListener] Leaving the key to the control Tab focused.",
        );
        return;
      }

      // --- Specific Shortcut Handling ---

      // Handle Ctrl+F — Cmd+F on a Mac — to open search modal
      if (event.key === "f" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        console.log(
          "[KeyboardListener] Search chord detected, opening search modal.",
        );
        openSearchModal();
        return;
      }

      // Handle Shift+? to open help modal
      if (event.key === "?" && event.shiftKey) {
        event.preventDefault();
        console.log("[KeyboardListener] Shift+? detected, opening help modal.");
        openHelpModal(); // Use the centralized utility function
        return;
      }

      // If search modal is open, only allow Escape (handled within modal component)
      if (isSearchModalOpen) {
        console.log(
          "[KeyboardListener] Ignoring key press while search modal is open.",
        );
        return;
      }

      // Handle Enter key to play emergency sound
      if (event.key === "Enter") {
        event.preventDefault();
        console.log("[KeyboardListener] Enter key detected.");

        // Resume AudioContext on first interaction
        if (!hasInteracted.current) {
          console.log(
            "[KeyboardListener] Resuming AudioContext due to Enter key.",
          );
          ensureAudioContextActive();
          hasInteracted.current = true;
        }

        let sound = takeNextEmergencySound();

        // Nothing armed *and* nothing has ever tried to look: load on the spot
        // rather than making the first Enter of a session a no-op.
        if (!sound && !hasLoadedEmergencySounds()) {
          console.log("Attempting to load emergency sounds now...");
          await reloadEmergencySounds(activeProfileId);
          sound = takeNextEmergencySound();
        }

        if (!sound) {
          console.warn(
            "[KeyboardListener] Enter pressed but no emergency sounds are loaded. Mark a bank as emergency in edit mode.",
          );
          return;
        }

        await playEmergencySound(sound); // Await playback
        return; // Stop further processing
      }

      // Handle Shift key press to toggle edit mode (Press)
      if (event.key === "Shift") {
        // Check if Shift is the *only* key being pressed (or with standard modifiers)
        // This prevents triggering edit mode when typing Shift+A, etc.
        // Note: This check might be overly simplistic depending on exact needs.
        if (!useProfileStore.getState().isEditMode) {
          console.log(
            "[KeyboardListener] Shift key pressed, entering edit mode.",
          );
          editModeFromShiftRef.current = true;
          setEditMode(true);
        }
        return; // Don't process Shift for pad activation
      }

      // Handle Escape key as "panic button" to stop all audio
      if (event.key === "Escape") {
        event.preventDefault();
        console.log(
          "[KeyboardListener] Escape key pressed - stopping all audio playback.",
        );
        stopAllAudio(); // Use the imported function
        // Panic is also the way out of the chrome. Tab can now reach the
        // header and the bank tabs, and a control that holds focus keeps
        // Enter and Space for itself — so the operator needs one key that
        // both stops the room and hands the instrument back, without hunting
        // for the mouse.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused !== document.body) {
          focused.blur();
        }
        focusReachedByTabRef.current = false;
        return;
      }

      // Handle Space key to fade out all audio
      if (event.key === " ") {
        event.preventDefault(); // Prevent default space action (e.g., scrolling)
        console.log(
          "[KeyboardListener] Space key pressed - fading out all audio playback.",
        );
        fadeOutAllAudio(); // Use the imported function
        return; // Don't process further for pad matching
      }

      // Handle F9 key to play the next armed track
      if (event.key === "F9") {
        event.preventDefault();
        console.log(
          "[KeyboardListener] F9 key pressed - playing next armed track.",
        );
        // Resume AudioContext on first interaction (if not already done)
        if (!hasInteracted.current) {
          console.log(
            "[KeyboardListener] Resuming AudioContext due to F9 key.",
          );
          ensureAudioContextActive();
          hasInteracted.current = true;
        }

        // Play the next armed track
        playbackStoreActions.playNextArmedTrack();
        return;
      }

      // Bank switching with number keys 1-9 and 0
      const numbersRegex = /^[0-9]$/;
      if (numbersRegex.test(event.key)) {
        if (event.ctrlKey) {
          // Ctrl+Number for banks 11-20.
          //
          // Ctrl and not Cmd, on every platform including macOS: Cmd+1..9 is
          // the browser's own tab switcher and is not cancellable from the
          // page, so binding it would promise a bank and deliver a tab. Ctrl
          // with a digit does reach the page on a Mac — unlike Ctrl+click,
          // which the OS claims as the secondary click — so this one needs no
          // second chord.
          event.preventDefault();
          const altBankNumber =
            event.key === "0" ? 20 : 10 + parseInt(event.key, 10);
          console.log(
            `[KeyboardListener] Ctrl+${event.key} detected, switching to bank ${altBankNumber}`,
          );
          setCurrentPageIndex(altBankNumber);
          return;
        } else if (!event.shiftKey && !event.altKey && !event.metaKey) {
          // Just Number key for banks 1-10
          event.preventDefault();
          const bankNumber = event.key === "0" ? 10 : parseInt(event.key, 10);
          // Convert to the format expected by setCurrentPageIndex (bank 10 should be passed as 0)
          const storeBankNumber =
            event.key === "0" ? 0 : parseInt(event.key, 10);
          console.log(
            `[KeyboardListener] Number key ${event.key} detected, switching to bank ${bankNumber}`,
          );
          setCurrentPageIndex(storeBankNumber);
          return;
        }
      }

      // --- Start of Pad Activation Logic ---

      // Nothing to act on until the store has resolved the bank on screen,
      // and nothing to key the loading state by without a profile. The second
      // half used to be an `activeProfileId as number` at the trigger call and
      // a `=== null` check inside three of its callbacks — a cast that said
      // the value could not be null next to three guards saying it could.
      if (currentBankId === null || activeProfileId === null) {
        return;
      }

      // Ignore if modifier keys are pressed (allow Shift for default keys, but handled above for edit mode)
      // Ctrl/Meta/Alt should prevent pad activation here.
      if (event.metaKey || event.altKey || event.ctrlKey) {
        console.log(
          "[KeyboardListener] Ignoring key press for pad activation due to modifier key.",
        );
        return;
      }

      // Check debounce (moved after specific shortcuts)
      if (keyDebounceMap.has(event.key)) {
        console.log(
          `[KeyboardListener] Debouncing key for pad activation: ${event.key}`,
        );
        return;
      }

      let matchedConfig: PadConfiguration | null = null;
      let matchedPadIndex: number = -1;
      const pressedKeyLower = event.key.toLowerCase();

      console.log(
        `[KeyboardListener] Checking custom bindings for key: ${event.key}`,
      );
      // 1. Check for custom key bindings in the pre-loaded map
      for (const [padIndex, config] of padConfigsRef.current.entries()) {
        if (
          config.keyBinding &&
          config.keyBinding.toLowerCase() === pressedKeyLower
        ) {
          matchedConfig = config;
          matchedPadIndex = padIndex;
          console.log(
            `[KeyboardListener] Custom binding found: Pad ${padIndex} for key ${event.key}`,
          );
          break;
        }
      }

      // 2. If no custom binding, check for default key bindings
      if (!matchedConfig) {
        console.log(
          `[KeyboardListener] No custom binding found. Checking default bindings for key: ${event.key}`,
        );
        const defaultPadIndex = getPadIndexForKey(pressedKeyLower); // Handles ' ', 'Escape' etc.

        if (defaultPadIndex !== undefined) {
          console.log(
            `[KeyboardListener] Key ${event.key} maps to default pad index: ${defaultPadIndex}`,
          );
          const config = padConfigsRef.current.get(defaultPadIndex);
          if (config) {
            if (!config.keyBinding) {
              // Ensure it doesn't have a custom binding
              matchedConfig = config;
              matchedPadIndex = defaultPadIndex;
              console.log(
                `[KeyboardListener] Default binding found: Pad ${defaultPadIndex} for key ${event.key}`,
              );
            } else {
              console.log(
                `[KeyboardListener] Default index ${defaultPadIndex} has custom binding "${config.keyBinding}", ignoring default activation for key ${event.key}.`,
              );
            }
          } else {
            console.log(
              `[KeyboardListener] No configuration found for default pad index: ${defaultPadIndex}`,
            );
          }
        } else {
          console.log(
            `[KeyboardListener] No default mapping found for key: ${event.key}`,
          );
        }
      }

      // 3. A disabled pad ignores its key entirely
      if (matchedConfig?.isDisabled) {
        console.log(
          `[KeyboardListener] Pad ${matchedPadIndex} is disabled, ignoring key ${event.key}.`,
        );
        return;
      }

      // 4. Trigger audio if a match was found and it has audio file(s)
      if (
        matchedConfig &&
        matchedConfig.audioFileIds &&
        matchedConfig.audioFileIds.length > 0
      ) {
        console.log(
          `[KeyboardListener] Match found: Pad ${matchedPadIndex}, Name: ${matchedConfig.name || "Unnamed"}, Audio IDs: ${matchedConfig.audioFileIds.join(", ")}`,
        );
        event.preventDefault(); // Prevent default browser action

        // Set debounce flag
        keyDebounceMap.set(event.key, true);
        setTimeout(() => keyDebounceMap.delete(event.key), DEBOUNCE_TIME_MS);

        // Resume AudioContext on first interaction (if not already done)
        if (!hasInteracted.current) {
          console.log(
            "[KeyboardListener] Resuming AudioContext due to pad activation key.",
          );
          ensureAudioContextActive();
          hasInteracted.current = true;
        }

        // Through `triggerPad`, like every other trigger in the app. This
        // branch used to build `triggerAudioForPadInstant`'s four callbacks by
        // hand — a second copy of the loading-key bookkeeping that had already
        // drifted from the shared one, and that never cleared the overlay for
        // a trigger cancelled mid-load.
        //
        // `extractPadPlaybackSettings` rather than a hand-written field list,
        // for the reason spelled out on `TriggerablePad`: a spread is exempt
        // from excess-property checking, so an enumerated field that goes
        // missing goes missing in silence.
        await triggerPad(
          {
            ...extractPadPlaybackSettings(matchedConfig),
            padIndex: matchedConfig.padIndex,
          },
          { activeProfileId, currentBankId },
          { logPrefix: "[KeyboardListener] keyboard shortcut" },
        );
      } else if (matchedConfig) {
        console.log(
          `[KeyboardListener] Matched pad ${matchedPadIndex} for key ${event.key}, but it has no audio files.`,
        );
      } else {
        // This log might be redundant given previous logs, but can be useful
        // console.log(`[KeyboardListener] No matching pad with audio found for key: ${event.key}`);
      }
    },
    [
      activeProfileId,
      currentBankId,
      setCurrentPageIndex,
      setEditMode,
      openSearchModal,
      isSearchModalOpen,
      isModalOpen,
      isAnyOverlayOpen,
      modalConfig,
    ],
  );

  // Clear edit mode that was entered by holding Shift, leaving button-set edit mode alone
  const clearShiftEditMode = useCallback(() => {
    if (!editModeFromShiftRef.current) return;
    editModeFromShiftRef.current = false;
    setEditMode(false);
  }, [setEditMode]);

  // Kept in a ref so the unmount-only effect below can call the latest version
  // without taking it as a dependency (which would defeat the point). Assigned
  // in an effect rather than during render — the only reader is that effect's
  // cleanup, which runs long after every effect has flushed.
  const clearShiftEditModeRef = useRef(clearShiftEditMode);
  useEffect(() => {
    clearShiftEditModeRef.current = clearShiftEditMode;
  });

  // Add a keyup handler to detect when shift key is released
  const handleKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        clearShiftEditMode();
      }
    },
    [clearShiftEditMode],
  );

  // The keyup for Shift never arrives if the window loses focus while it is held
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearShiftEditMode();
      }
    };

    window.addEventListener("blur", clearShiftEditMode);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", clearShiftEditMode);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [clearShiftEditMode]);

  useEffect(() => {
    console.log("[KeyboardListener] Adding event listeners.");
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // Cleanup listeners on unmount
    return () => {
      console.log("[KeyboardListener] Removing event listeners.");
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]); // Re-attach listeners if callbacks change

  // Ensure Shift-held edit mode is turned off when the component unmounts.
  //
  // This deliberately lives in its own mount-only effect rather than in the
  // listener cleanup above: that effect re-runs whenever handleKeyDown changes
  // — on profile load, bank switch, sync (padConfigsVersion) and modal state —
  // and clearing there would drop edit mode while Shift is still physically
  // held down.
  useEffect(() => {
    return () => {
      clearShiftEditModeRef.current();
    };
  }, []);
}
