import { useEffect, useCallback, useRef } from 'react';
import { useProfileStore } from '@/store/profileStore';
import { PadConfiguration, getPadConfigurationsForProfilePage, getAllPageMetadataForProfile } from '@/lib/db';
import { loadAndDecodeAudio, playAudio, resumeAudioContext, stopAllAudio, fadeOutAllAudio } from '@/lib/audio';
import { useSearchModal } from '@/components/SearchModalProvider';
import { getDefaultKeyForPadIndex } from '@/lib/keyboardUtils'; // Import the shared function

// Interface for emergency sound configuration
interface EmergencySound {
  profileId: number;
  pageIndex: number;
  padIndex: number;
  audioFileId: number;
  name?: string;
}

// Re-use the audio buffer cache from PadGrid (consider moving cache to audio.ts or a context)
const audioBufferCache = new Map<number, AudioBuffer | null>();

// Global reference to track emergency sounds and current index for round-robin
const emergencySoundsRef: { current: EmergencySound[] } = { current: [] };
const currentEmergencyIndexRef: { current: number } = { current: 0 };

// Debounce map to prevent rapid re-triggering
const keyDebounceMap = new Map<string, boolean>();
const DEBOUNCE_TIME_MS = 100; // Adjust as needed

// Load all emergency sounds from emergency pages
async function loadEmergencySounds(profileId: number): Promise<EmergencySound[]> {
  if (!profileId) return [];
  
  try {
    // 1. Get all pages for the profile
    const allPages = await getAllPageMetadataForProfile(profileId);
    
    // 2. Filter to just emergency pages
    const emergencyPages = allPages.filter(page => page.isEmergency);
    
    if (emergencyPages.length === 0) {
      console.log('No emergency pages found');
      return [];
    }
    
    console.log(`Found ${emergencyPages.length} emergency pages`);
    
    // 3. Get all configured pads for these pages
    const allEmergencySounds: EmergencySound[] = [];
    
    for (const page of emergencyPages) {
      const padConfigs = await getPadConfigurationsForProfilePage(profileId, page.pageIndex);
      
      // Only include pads with audio files
      const configuredPads = padConfigs.filter(pad => pad.audioFileId);
      
      const emergencySoundsForPage = configuredPads.map(pad => ({
        profileId,
        pageIndex: page.pageIndex,
        padIndex: pad.padIndex,
        audioFileId: pad.audioFileId as number,
        name: pad.name
      }));
      
      allEmergencySounds.push(...emergencySoundsForPage);
    }
    
    console.log(`Loaded ${allEmergencySounds.length} emergency sounds`);
    return allEmergencySounds;
  } catch (error) {
    console.error('Error loading emergency sounds:', error);
    return [];
  }
}

// Function to play an emergency sound
async function playEmergencySound(sound: EmergencySound): Promise<void> {
  if (!sound || !sound.audioFileId) {
    console.error('Invalid emergency sound configuration');
    return;
  }
  
  try {
    // Check if we have the audio buffer cached
    let buffer = audioBufferCache.get(sound.audioFileId);
    if (!buffer) {
      // Load and decode the audio if not cached
      buffer = await loadAndDecodeAudio(sound.audioFileId);
      if (buffer) {
        audioBufferCache.set(sound.audioFileId, buffer);
      }
    }
    
    if (buffer) {
      // Generate a unique playback key for this emergency sound
      const playbackKey = `emergency-${sound.profileId}-${sound.pageIndex}-${sound.padIndex}-${Date.now()}`;
      
      // Play the audio
      playAudio(
        buffer,
        playbackKey,
        {
          name: sound.name || 'Emergency Sound',
          padInfo: {
            profileId: sound.profileId,
            pageIndex: sound.pageIndex,
            padIndex: sound.padIndex
          }
        }
      );
      
      console.log(`Playing emergency sound: ${sound.name || 'Unnamed'} from page ${sound.pageIndex}, pad ${sound.padIndex}`);
    } else {
      console.error(`Failed to load audio buffer for emergency sound ID: ${sound.audioFileId}`);
    }
  } catch (error) {
    console.error('Error playing emergency sound:', error);
  }
}

export function useKeyboardListener() {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // Get current page index and setter from store
  const currentPageIndex = useProfileStore((state) => state.currentPageIndex);
  const setCurrentPageIndex = useProfileStore((state) => state.setCurrentPageIndex);
  // Get edit mode states and setters from store
  const setEditMode = useProfileStore((state) => state.setEditMode);
  const isEditing = useProfileStore((state) => state.isEditing);
  // Get emergency sounds version to detect changes
  const emergencySoundsVersion = useProfileStore((state) => state.emergencySoundsVersion);
  // Get search modal context
  const { openSearchModal, isSearchModalOpen } = useSearchModal();
  
  const hasInteracted = useRef(false); // Track interaction for AudioContext resume

  // We need access to the current pad configurations for the active page
  // Fetching them here might be inefficient if PadGrid already has them.
  // Consider passing configs down or using a shared state/context.
  // For now, fetch directly within the hook for simplicity.
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
    console.log(`Loading emergency sounds (version: ${emergencySoundsVersion})`);
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
    // Ignore if typing in an input field, textarea, etc.
    const targetElement = event.target as HTMLElement;
    if (targetElement.tagName === 'INPUT' || targetElement.tagName === 'TEXTAREA' || targetElement.isContentEditable) {
      return;
    }

    const pressedKey = event.key; // e.g., "F1", "a", "1", "Enter"
    
    // Handle Ctrl+F to open search modal
    if (pressedKey === 'f' && event.ctrlKey) {
      event.preventDefault();
      openSearchModal();
      return;
    }
    
    // If search modal is open, don't process other keyboard shortcuts except Escape (handled in modal)
    if (isSearchModalOpen) {
      return;
    }
    
    // Handle Enter key to play emergency sound
    if (pressedKey === 'Enter') {
      event.preventDefault();
      
      // Resume AudioContext on first interaction
      if (!hasInteracted.current) {
        resumeAudioContext();
        hasInteracted.current = true;
      }
      
      // Check if we have any emergency sounds loaded
      if (emergencySoundsRef.current.length > 0) {
        // Get the current emergency sound (round-robin)
        const index = currentEmergencyIndexRef.current;
        const sound = emergencySoundsRef.current[index];
        
        // Update index for next time (round-robin)
        currentEmergencyIndexRef.current = (index + 1) % emergencySoundsRef.current.length;
        
        // Play the sound
        console.log(`Enter key pressed - playing emergency sound ${index + 1}/${emergencySoundsRef.current.length}`);
        console.log(`Emergency sound details: ${sound.name || 'Unnamed'} from page ${sound.pageIndex}, pad ${sound.padIndex}`);
        await playEmergencySound(sound);
      } else {
        console.warn('Enter key pressed but no emergency sounds are configured');
        
        // If we haven't loaded emergency sounds yet, try loading them now
        if (!hasLoadedEmergencySounds.current) {
          console.log('Attempting to load emergency sounds now...');
          await reloadEmergencySounds();
          
          // Check again after loading
          if (emergencySoundsRef.current.length > 0) {
            const sound = emergencySoundsRef.current[0];
            console.log(`Found ${emergencySoundsRef.current.length} emergency sounds after loading, playing first one`);
            await playEmergencySound(sound);
            currentEmergencyIndexRef.current = 1; // Set index to 1 for next time
          } else {
            console.warn('No emergency sounds found. Make sure to mark pages as emergency in settings.');
          }
        }
      }
      
      return;
    }
    
    // Handle Shift key press to toggle edit mode
    if (pressedKey === 'Shift') {
      setEditMode(true);
      return;
    }
        
    // Handle Escape key as "panic button" to stop all audio (only if search modal is closed)
    if (pressedKey === 'Escape' && !isSearchModalOpen) {
        event.preventDefault();
        console.log('Escape key pressed - stopping all audio playback');
        stopAllAudio();
        return;
    }

    // Handle Space key to fade out all audio (only if search modal is closed)
    if (pressedKey === ' ' && !isSearchModalOpen) {
        event.preventDefault(); // Prevent default space action (e.g., scrolling)
        console.log('Space key pressed - fading out all audio playback');
        fadeOutAllAudio(); // Use the imported function
        return; // Don't process further for pad matching
    }
    
    // Bank switching with number keys 1-9 and 0
    const numbersRegex = /^[0-9]$/;
    if (numbersRegex.test(pressedKey)) {
        // If the Ctrl key is pressed, handle banks 11-20
        if (event.ctrlKey) {
            event.preventDefault();
            // Ctrl+1 maps to bank 11, Ctrl+2 to bank 12, etc. Ctrl+0 maps to bank 20
            const altBankNumber = pressedKey === '0' ? 20 : 10 + parseInt(pressedKey, 10);
            
            // Update the bank index in the store
            setCurrentPageIndex(altBankNumber);
            
            // Return early to prevent pad triggering with the same key
            return;
        } else {
            event.preventDefault();
            // Regular number keys 1-9 map to banks 1-9, 0 maps to bank 10
            const bankNumber = parseInt(pressedKey, 10);
            
            // Update the bank index in the store
            console.log(`Number key ${pressedKey} pressed, switching to bank ${bankNumber === 0 ? 10 : bankNumber}`);
            setCurrentPageIndex(bankNumber);
            
            // Return early to prevent pad triggering with the same key
            return;
        }
    }

    // Ignore if Ctrl or Meta keys are pressed (but still allow Ctrl for bank switching)
    if (event.metaKey || event.ctrlKey) {
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
  }, [activeProfileId, currentPageIndex, setCurrentPageIndex, setEditMode, reloadEmergencySounds, openSearchModal, isSearchModalOpen]); // Dependencies for the callback
  
  // Add a keyup handler to detect when shift key is released
  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      // Only exit edit mode if we're not currently editing something
      if (!isEditing) {
        setEditMode(false);
      } else {
      }
    }
  }, [setEditMode, isEditing]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    console.log('Keyboard listeners added.');

    // Cleanup listeners on unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      // Ensure edit mode is turned off when component unmounts
      setEditMode(false);
      console.log('Keyboard listeners removed.');
    };
  }, [handleKeyDown, handleKeyUp, setEditMode]); // Re-attach listeners if callbacks change
}
