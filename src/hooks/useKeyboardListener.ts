import { useEffect, useCallback, useRef } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  PadConfiguration,
  PlaybackType,
  getPadConfigurationsForProfilePage,
  getAllPageMetadataForProfile,
} from "@/lib/db";
import {
  ensureAudioContextActive,
  stopAllAudio,
  fadeOutAllAudio,
  triggerAudioForPad,
} from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { useSearchModal } from "@/components/SearchModalProvider";
import { useUIStore } from "@/store/uiStore";
import { getPadIndexForKey } from "@/lib/keyboardUtils";
import { openHelpModal } from "@/lib/uiUtils";

// Interface for emergency sound configuration
interface EmergencySound {
  profileId: number;
  pageIndex: number;
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  name?: string;
}

// Global reference to track emergency sounds and current index for round-robin
const emergencySoundsRef: { current: EmergencySound[] } = { current: [] };
const currentEmergencyIndexRef: { current: number } = { current: 0 };

// Debounce map to prevent rapid re-triggering
const keyDebounceMap = new Map<string, boolean>();
const DEBOUNCE_TIME_MS = 100; // Adjust as needed

// Load all emergency sounds from emergency pages
async function loadEmergencySounds(
  profileId: number,
): Promise<EmergencySound[]> {
  if (!profileId) return [];

  try {
    // 1. Get all pages for the profile
    const allPages = await getAllPageMetadataForProfile(profileId);

    // 2. Filter to just emergency pages
    const emergencyPages = allPages.filter((page) => page.isEmergency);

    if (emergencyPages.length === 0) {
      console.log("No emergency pages found");
      return [];
    }

    console.log(`Found ${emergencyPages.length} emergency pages`);

    // 3. Get all configured pads for these pages
    const allEmergencySounds: EmergencySound[] = [];

    for (const page of emergencyPages) {
      const padConfigs = await getPadConfigurationsForProfilePage(
        profileId,
        page.pageIndex,
      );

      // Only include pads with audio files
      const configuredPads = padConfigs.filter(
        (pad) => pad.audioFileIds && pad.audioFileIds.length > 0,
      );

      // Map configured pads to EmergencySound objects
      const emergencySoundsForPage = configuredPads.map((pad) => ({
        profileId,
        pageIndex: page.pageIndex,
        padIndex: pad.padIndex,
        audioFileIds: pad.audioFileIds!,
        playbackType: pad.playbackType,
        name: pad.name,
      }));

      allEmergencySounds.push(...emergencySoundsForPage);
    }

    console.log(`Loaded ${allEmergencySounds.length} emergency sounds`);
    return allEmergencySounds;
  } catch (error) {
    console.error("Error loading emergency sounds:", error);
    return [];
  }
}

// Function to play an emergency sound
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

  // Call the centralized trigger function with the new signature
  await triggerAudioForPad({
    padIndex: sound.padIndex,
    audioFileIds: sound.audioFileIds,
    playbackType: sound.playbackType,
    activeProfileId: sound.profileId,
    currentPageIndex: sound.pageIndex, // Use the pageIndex from the sound object
    name: sound.name,
  });
}

export function useKeyboardListener() {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // Get current page index and setter from store
  const currentPageIndex = useProfileStore((state) => state.currentPageIndex);
  const setCurrentPageIndex = useProfileStore(
    (state) => state.setCurrentPageIndex,
  );
  // Get edit mode states and setters from store
  const setEditMode = useProfileStore((state) => state.setEditMode);
  // Get emergency sounds version to detect changes
  const emergencySoundsVersion = useProfileStore(
    (state) => state.emergencySoundsVersion,
  );

  // Get search modal context
  const { openSearchModal, isSearchModalOpen } = useSearchModal();
  // Get modal state and actions from UI store individually to prevent unnecessary re-renders
  const isModalOpen = useUIStore((state) => state.isModalOpen);
  const modalConfig = useUIStore((state) => state.modalConfig);
  const closeModal = useUIStore((state) => state.closeModal);

  const hasInteracted = useRef(false); // Track interaction for AudioContext resume

  // We need access to the current pad configurations for the active page
  // Fetching them here might be inefficient if PadGrid already has them.
  // Consider passing configs down or using a shared state/context.
  // For now, fetch directly within the hook.
  // This map will store ALL configurations for the current page, keyed by padIndex.
  const padConfigsRef = useRef<Map<number, PadConfiguration>>(new Map());

  // Reference to track if we've loaded emergency sounds
  const hasLoadedEmergencySounds = useRef(false);

  // Function to reload emergency sounds - can be called when needed
  const reloadEmergencySounds = useCallback(async () => {
    console.log("Reloading emergency sounds...");
    if (activeProfileId === null) {
      console.log("No active profile, skipping emergency sounds load");
      return;
    }

    // Load emergency sounds
    const sounds = await loadEmergencySounds(activeProfileId);
    emergencySoundsRef.current = sounds;
    currentEmergencyIndexRef.current = 0; // Reset index when loading new sounds

    hasLoadedEmergencySounds.current = true;
    console.log(`Reloaded ${sounds.length} emergency sounds`);
  }, [activeProfileId]);

  // Effect to load emergency sounds when profile changes or when emergency sounds version changes
  useEffect(() => {
    console.log(
      `Loading emergency sounds (version: ${emergencySoundsVersion})`,
    );
    reloadEmergencySounds();

    // Set up a periodic refresh (every 60 seconds) as a fallback
    // This ensures emergency sounds are up to date even if an update is missed
    const intervalId = setInterval(() => {
      reloadEmergencySounds();
    }, 60000);

    return () => clearInterval(intervalId);
  }, [activeProfileId, reloadEmergencySounds, emergencySoundsVersion]);

  // Effect to load pad configurations
  useEffect(() => {
    const loadConfigs = async () => {
      if (activeProfileId === null) {
        padConfigsRef.current = new Map();
        return;
      }
      try {
        const configs = await getPadConfigurationsForProfilePage(
          activeProfileId,
          currentPageIndex,
        );
        // Store ALL configurations for the page, mapping padIndex to config
        const configMap = new Map<number, PadConfiguration>(
          configs.map((config) => [config.padIndex, config]),
        );
        padConfigsRef.current = configMap;
        console.log(
          `[KeyboardListener] Loaded ${configMap.size} pad configurations for profile ${activeProfileId}, page ${currentPageIndex}`,
        );
      } catch (error) {
        console.error(
          `[KeyboardListener] Failed to load pad configurations for profile ${activeProfileId}, page ${currentPageIndex}:`,
          error,
        );
      }
    };
    loadConfigs();
  }, [activeProfileId, currentPageIndex]);

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      console.log(
        `[KeyboardListener] KeyDown: ${event.key}, Ctrl: ${event.ctrlKey}, Shift: ${event.shiftKey}, Meta: ${event.metaKey}`,
      ); // Base log for any key press

      // --- Ctrl+S to Confirm/Close Modal ---
      // IMPORTANT: This must come BEFORE the input/textarea check
      if (event.key === "s" && event.ctrlKey) {
        if (isModalOpen) {
          event.preventDefault();
          console.log(
            "[KeyboardListener] Ctrl+S detected: Modal open. Attempting confirm and close.",
          );
          try {
            await modalConfig?.onConfirm?.(); // Await the confirm action
          } catch (error) {
            console.error(
              "[KeyboardListener] Error during modal confirm on Ctrl+S:",
              error,
            );
          } finally {
            closeModal(); // Always close
          }
          return; // Stop further processing
        }
      }

      // Prevent default browser tabbing behavior
      if (event.key === "Tab") {
        event.preventDefault();
        return; // Stop further processing for Tab key
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

      // --- Specific Shortcut Handling ---

      // Handle Ctrl+F to open search modal
      if (event.key === "f" && event.ctrlKey) {
        event.preventDefault();
        console.log(
          "[KeyboardListener] Ctrl+F detected, opening search modal.",
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

        if (emergencySoundsRef.current.length > 0) {
          const index = currentEmergencyIndexRef.current;
          const sound = emergencySoundsRef.current[index];
          currentEmergencyIndexRef.current =
            (index + 1) % emergencySoundsRef.current.length; // Update index
          console.log(
            `[KeyboardListener] Playing emergency sound ${index + 1}/${emergencySoundsRef.current.length}: Pad ${sound.padIndex}`,
          );
          await playEmergencySound(sound); // Await playback
        } else {
          console.warn(
            "[KeyboardListener] Enter pressed but no emergency sounds loaded.",
          );

          // If we haven't loaded emergency sounds yet, try loading them now
          if (!hasLoadedEmergencySounds.current) {
            console.log("Attempting to load emergency sounds now...");
            await reloadEmergencySounds();

            // Check again after loading
            if (emergencySoundsRef.current.length > 0) {
              const sound = emergencySoundsRef.current[0];
              console.log(
                `Found ${emergencySoundsRef.current.length} emergency sounds after loading, playing first one`,
              );
              await playEmergencySound(sound);
              currentEmergencyIndexRef.current = 1; // Set index to 1 for next time
            } else {
              console.warn(
                "No emergency sounds found. Make sure to mark pages as emergency in settings.",
              );
            }
          }
        }
        return; // Stop further processing
      }

      // Handle Shift key press to toggle edit mode (Press)
      if (event.key === "Shift") {
        // Check if Shift is the *only* key being pressed (or with standard modifiers)
        // This prevents triggering edit mode when typing Shift+A, etc.
        // Note: This check might be overly simplistic depending on exact needs.
        console.log(
          "[KeyboardListener] Shift key pressed, entering edit mode.",
        );
        setEditMode(true);
        return; // Don't process Shift for pad activation
      }

      // Handle Escape key as "panic button" to stop all audio
      if (event.key === "Escape") {
        event.preventDefault();
        console.log(
          "[KeyboardListener] Escape key pressed - stopping all audio playback.",
        );
        stopAllAudio(); // Use the imported function
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
          // Ctrl+Number for banks 11-20
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
          console.log(
            `[KeyboardListener] Number key ${event.key} detected, switching to bank ${bankNumber}`,
          );
          setCurrentPageIndex(bankNumber);
          return;
        }
      }

      // --- Start of Pad Activation Logic ---

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
        const defaultPadIndex = getPadIndexForKey(event.key); // Handles ' ', 'Escape' etc.

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

      // 3. Trigger audio if a match was found and it has audio file(s)
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

        console.log(
          `[KeyboardListener] Calling triggerAudioForPad for pad index ${matchedPadIndex}`,
        );
        // Call triggerAudioForPad with the new signature, destructuring the config
        triggerAudioForPad({
          padIndex: matchedConfig.padIndex,
          audioFileIds: matchedConfig.audioFileIds,
          playbackType: matchedConfig.playbackType,
          activeProfileId: activeProfileId as number,
          currentPageIndex: currentPageIndex,
          name: matchedConfig.name,
        });
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
      currentPageIndex,
      setCurrentPageIndex,
      setEditMode,
      reloadEmergencySounds,
      openSearchModal,
      isSearchModalOpen,
      isModalOpen,
      modalConfig,
      closeModal,
    ],
  );

  // Add a keyup handler to detect when shift key is released
  const handleKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        setEditMode(false);
      }
    },
    [setEditMode],
  );

  useEffect(() => {
    console.log("[KeyboardListener] Adding event listeners.");
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // Cleanup listeners on unmount
    return () => {
      console.log("[KeyboardListener] Removing event listeners.");
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      // Ensure edit mode is turned off when component unmounts
      setEditMode(false);
    };
  }, [handleKeyDown, handleKeyUp, setEditMode]); // Re-attach listeners if callbacks or setEditMode change
}
