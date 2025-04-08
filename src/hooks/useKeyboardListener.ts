import { useEffect, useCallback, useRef } from 'react';
import { useProfileStore } from '@/store/profileStore';
import { PadConfiguration, getPadConfigurationsForProfilePage } from '@/lib/db';
import { loadAndDecodeAudio, playAudio, resumeAudioContext, stopAllAudio } from '@/lib/audio';

// Define a key mapping for a standard keyboard layout
// This provides the default key bindings for pads based on their index
const getDefaultKeyForPadIndex = (padIndex: number, cols: number = 8): string | undefined => {
  // Define keyboard rows with their keys
  const keyboardRows = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']
  ];
  
  // Calculate row and column for the pad index
  const row = Math.floor(padIndex / cols);
  const col = padIndex % cols;
  
  // Check if we have a key defined for this position
  if (row < keyboardRows.length && col < keyboardRows[row].length) {
    return keyboardRows[row][col];
  }
  
  return undefined; // No default key for this position
};

// Re-use the audio buffer cache from PadGrid (consider moving cache to audio.ts or a context)
const audioBufferCache = new Map<number, AudioBuffer | null>();

// Debounce map to prevent rapid re-triggering
const keyDebounceMap = new Map<string, boolean>();
const DEBOUNCE_TIME_MS = 100; // Adjust as needed

export function useKeyboardListener() {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // Get current page index and setter from store
  const currentPageIndex = useProfileStore((state) => state.currentPageIndex);
  const setCurrentPageIndex = useProfileStore((state) => state.setCurrentPageIndex);
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
    
    // Handle Escape key as "panic button" to stop all audio
    if (pressedKey === 'Escape') {
        event.preventDefault();
        console.log('Escape key pressed - stopping all audio playback');
        stopAllAudio();
        return;
    }
    
    // Check if key is a number 0-9 for bank switching
    const numbersRegex = /^[0-9]$/;
    if (numbersRegex.test(pressedKey)) {
        event.preventDefault();
        const bankIndex = parseInt(pressedKey, 10);
        
        // Update the bank index in the store
        console.log(`Bank switching key pressed: ${pressedKey}, switching to bank ${bankIndex}`);
        setCurrentPageIndex(bankIndex);
        
        // Return early to prevent pad triggering with the same key
        return;
    }

    // Check debounce
    if (keyDebounceMap.has(pressedKey)) {
        return;
    }

    // First try to find a pad with a custom key binding that matches
    let matchedConfig: PadConfiguration | null = null;
    let matchedPadIndex: number = -1;

    // Check for custom key bindings first
    for (const [padIndex, config] of padConfigsRef.current.entries()) {
        // Case-insensitive comparison might be desirable depending on requirements
        if (config.keyBinding && config.keyBinding.toLowerCase() === pressedKey.toLowerCase()) {
            matchedConfig = config;
            matchedPadIndex = padIndex;
            break;
        }
    }

    // If no custom key binding found, check for default key bindings
    if (!matchedConfig) {
        // Get all pad configurations for the current page
        const allPadConfigs = await getPadConfigurationsForProfilePage(activeProfileId as number, currentPageIndex);
        
        // Find pad index that would have this default key
        for (let i = 0; i < allPadConfigs.length; i++) {
            const config = allPadConfigs[i];
            const defaultKey = getDefaultKeyForPadIndex(config.padIndex);
            
            if (defaultKey && defaultKey.toLowerCase() === pressedKey.toLowerCase()) {
                matchedConfig = config;
                matchedPadIndex = config.padIndex;
                break;
            }
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
                playAudio(
                    buffer, 
                    playbackKey,
                    {
                        name: matchedConfig.name || `Pad ${matchedPadIndex + 1}`,
                        padInfo: {
                            profileId: activeProfileId as number,
                            pageIndex: currentPageIndex,
                            padIndex: matchedPadIndex
                        }
                    }
                );
                // Optionally add visual feedback for keyboard activation?
            } else {
                console.error(`Failed to load/decode audio for key "${pressedKey}", file ID: ${audioFileId}`);
            }
        } catch (error) {
            console.error(`Error during keyboard playback for key "${pressedKey}":`, error);
        }
    }
  }, [activeProfileId, currentPageIndex, setCurrentPageIndex]); // Dependencies for the callback

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
