import { useEffect, useCallback, useRef } from 'react';
import { useProfileStore } from '@/store/profileStore';
import { PadConfiguration, getPadConfigurationsForProfilePage } from '@/lib/db';
import { loadAndDecodeAudio, playAudio, resumeAudioContext } from '@/lib/audio';

// Re-use the audio buffer cache from PadGrid (consider moving cache to audio.ts or a context)
const audioBufferCache = new Map<number, AudioBuffer | null>();

// Debounce map to prevent rapid re-triggering
const keyDebounceMap = new Map<string, boolean>();
const DEBOUNCE_TIME_MS = 100; // Adjust as needed

export function useKeyboardListener() {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // Assuming PadGrid manages current page index, we might need a shared state later.
  // For now, let's assume page 0 for the listener.
  // TODO: Get currentPageIndex from a shared state/context later.
  const currentPageIndex = 0;
  const hasInteracted = useRef(false); // Track interaction for AudioContext resume

  // We need access to the current pad configurations for the active page
  // Fetching them here might be inefficient if PadGrid already has them.
  // Consider passing configs down or using a shared state/context.
  // For now, fetch directly within the hook for simplicity.
  const padConfigsRef = useRef<Map<number, PadConfiguration>>(new Map());

  useEffect(() => {
    const loadConfigs = async () => {
      if (activeProfileId === null) {
        padConfigsRef.current = new Map();
        return;
      }
      try {
        const configs = await getPadConfigurationsForProfilePage(activeProfileId, currentPageIndex);
        const configMap = new Map<number, PadConfiguration>();
        configs.forEach(config => {
          if (config.keyBinding) { // Only store configs with keybindings relevant to the listener
            configMap.set(config.padIndex, config);
          }
        });
        padConfigsRef.current = configMap;
        console.log(`Keyboard listener loaded ${configMap.size} configs with keybindings for page ${currentPageIndex}`);
      } catch (error) {
        console.error("Keyboard listener failed to load pad configurations:", error);
      }
    };
    loadConfigs();
  }, [activeProfileId, currentPageIndex]);


  const handleKeyDown = useCallback(async (event: KeyboardEvent) => {
    // Ignore if modifier keys are pressed (unless specifically intended)
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    // Ignore if typing in an input field, textarea, etc.
    const targetElement = event.target as HTMLElement;
    if (targetElement.tagName === 'INPUT' || targetElement.tagName === 'TEXTAREA' || targetElement.isContentEditable) {
        return;
    }

    const pressedKey = event.key; // e.g., "F1", "a", "1"

    // Check debounce
    if (keyDebounceMap.has(pressedKey)) {
        return;
    }

    // Find pad config matching the key binding
    let matchedConfig: PadConfiguration | null = null;
    let matchedPadIndex: number = -1;

    for (const [padIndex, config] of padConfigsRef.current.entries()) {
        // Case-insensitive comparison might be desirable depending on requirements
        if (config.keyBinding && config.keyBinding.toLowerCase() === pressedKey.toLowerCase()) {
            matchedConfig = config;
            matchedPadIndex = padIndex;
            break;
        }
    }

    if (matchedConfig && matchedConfig.audioFileId) {
        event.preventDefault(); // Prevent default browser action for the key (e.g., F1 help)

        // Set debounce flag
        keyDebounceMap.set(pressedKey, true);
        setTimeout(() => keyDebounceMap.delete(pressedKey), DEBOUNCE_TIME_MS);


        // Resume AudioContext on first interaction via keyboard
        if (!hasInteracted.current) {
            resumeAudioContext();
            hasInteracted.current = true;
        }

        const audioFileId = matchedConfig.audioFileId;
        const playbackKey = `pad-${activeProfileId}-${currentPageIndex}-${matchedPadIndex}`; // Consistent playback key

        console.log(`Key "${pressedKey}" matched pad index ${matchedPadIndex}, audio ID ${audioFileId}`);

        // Play audio (similar logic to handlePadClick)
        // TODO: Refactor playback logic into a reusable function?
        try {
            let buffer = audioBufferCache.get(audioFileId);
            if (!buffer) {
                buffer = await loadAndDecodeAudio(audioFileId);
                if (buffer) {
                    audioBufferCache.set(audioFileId, buffer);
                }
            }

            if (buffer) {
                // Note: Keyboard doesn't easily support "stop on press again" like click does.
                // It will always restart the sound or play over if not stopped.
                // We choose to restart by calling playAudio which implicitly stops the previous one with the same key.
                playAudio(buffer, playbackKey);
                // Optionally add visual feedback for keyboard activation?
            } else {
                console.error(`Failed to load/decode audio for key "${pressedKey}", file ID: ${audioFileId}`);
            }
        } catch (error) {
            console.error(`Error during keyboard playback for key "${pressedKey}":`, error);
        }
    }
  }, [activeProfileId, currentPageIndex]); // Dependencies for the callback

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    console.log('Keyboard listener added.');

    // Cleanup listener on unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      console.log('Keyboard listener removed.');
    };
  }, [handleKeyDown]); // Re-attach listener if handleKeyDown changes
}
