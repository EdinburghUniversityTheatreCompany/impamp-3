'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Pad from './Pad';
import { useProfileStore } from '@/store/profileStore';
import { useUIStore } from '@/store/uiStore'; // Import UI store
import PromptModalContent from './modals/PromptModalContent'; // Import modal content
import ConfirmModalContent from './modals/ConfirmModalContent'; // Import modal content
import {
  getPadConfigurationsForProfilePage,
  PadConfiguration,
  addAudioFile,
  upsertPadConfiguration,
} from '@/lib/db';
import { loadAndDecodeAudio, playAudio, stopAudio, resumeAudioContext, getActiveTracks } from '@/lib/audio';
// useDropzone will be used in Pad component

interface PadGridProps {
  rows?: number;
  cols?: number;
  currentPageIndex?: number; // Add page index prop
}

// Cache for decoded audio buffers to avoid re-decoding
const audioBufferCache = new Map<number, AudioBuffer | null>(); // Allow null for failed decodes

// Define a type for the detailed playback state of a pad
type PadPlaybackState = {
  progress: number;
  remainingTime: number;
  totalDuration: number;
};

const PadGrid: React.FC<PadGridProps> = ({ rows = 4, cols = 8, currentPageIndex = 0 }) => {
  const totalPads = rows * cols;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const isEditMode = useProfileStore((state) => state.isEditMode); 
  const setEditing = useProfileStore((state) => state.setEditing);
  const { openModal, closeModal } = useUIStore(); // Get modal actions
  const [padConfigs, setPadConfigs] = useState<Map<number, PadConfiguration>>(new Map()); // Map padIndex to config
  const [playingPads, setPlayingPads] = useState<Set<number>>(new Set());
  const [padPlaybackState, setPadPlaybackState] = useState<Map<number, PadPlaybackState>>(new Map());
  const hasInteracted = useRef(false);
  // Removed isDragging state, will handle visual feedback in Pad component

  // Function to refresh pad configurations after an update
  const refreshPadConfigs = useCallback(async () => {
      if (activeProfileId === null) return;
      console.log(`Refreshing pad configs for profile ${activeProfileId}, page ${currentPageIndex}`);
      try {
          const configs = await getPadConfigurationsForProfilePage(activeProfileId, currentPageIndex);
          const configMap = new Map<number, PadConfiguration>();
          configs.forEach(config => {
              configMap.set(config.padIndex, config);
          });
          setPadConfigs(configMap);
      } catch (error) {
          console.error("Failed to refresh pad configurations:", error);
      }
  }, [activeProfileId, currentPageIndex]);


  // Effect to update pad progress for all playing tracks
  useEffect(() => {
    // Always run this effect to update progress for any playing tracks
    const updatePlaybackState = () => {
      // Use getActiveTracks to get current playback details
      const tracks = getActiveTracks(); // This now returns { key, name, remainingTime, totalDuration, progress, isFading, padInfo }
      const newPlaybackState = new Map<number, PadPlaybackState>();
      const currentlyPlayingPads = new Set<number>();

      tracks.forEach(track => {
        const { padInfo, progress, remainingTime, totalDuration } = track;
        // Only track state for pads on the current page
        if (padInfo.pageIndex === currentPageIndex) {
          newPlaybackState.set(padInfo.padIndex, { progress, remainingTime, totalDuration });
          currentlyPlayingPads.add(padInfo.padIndex);
        }
      });

      // Update the state maps
      setPlayingPads(currentlyPlayingPads);
      setPadPlaybackState(newPlaybackState);
    };

    // Set interval for updates
    const intervalId = setInterval(updatePlaybackState, 100);
    return () => clearInterval(intervalId);
  }, [currentPageIndex]);

  useEffect(() => {
    const loadConfigs = async () => {
      if (activeProfileId === null) {
        setPadConfigs(new Map());
        return;
      }
      
      // Start loading but don't clear the previous configs yet
      // This keeps existing visuals while loading new data
      
      try {
        console.log(`Loading pad configs for profile ${activeProfileId}, page ${currentPageIndex}`);
        const configs = await getPadConfigurationsForProfilePage(activeProfileId, currentPageIndex);
        const configMap = new Map<number, PadConfiguration>();
        configs.forEach(config => {
          configMap.set(config.padIndex, config);
        });
        
        // Only update the pad configs once the new data is loaded
        setPadConfigs(configMap);
        console.log(`Loaded ${configs.length} pad configs.`);
      } catch (error) {
        console.error("Failed to load pad configurations:", error);
        // Error feedback could be added here
      }
    };

    loadConfigs();
  }, [activeProfileId, currentPageIndex, refreshPadConfigs]);

  // Track the Delete key state (Shift key state is now handled globally)
  const [isDeleteKeyDown, setIsDeleteKeyDown] = useState(false);

  // Set up event listeners to track delete key state
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // console.log('[PadGrid] Local Shift key down - setting local isShiftDown=true'); // <-- REMOVED LOG
      if (e.key === 'Delete') setIsDeleteKeyDown(true);
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      // console.log('[PadGrid] Local Shift key up - setting local isShiftDown=false'); // <-- REMOVED LOG
      if (e.key === 'Delete') setIsDeleteKeyDown(false);
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);


  // Handler for removing sound from a pad
  const handleRemoveSound = (padIndex: number) => { // Removed async
    const config = padConfigs.get(padIndex);
    if (!config || !config.audioFileId || activeProfileId === null) return;

    const soundName = config.name || `Pad ${padIndex + 1}`;

    openModal({
      title: 'Remove Sound',
      content: (
        <ConfirmModalContent message={`Remove sound "${soundName}" from this pad?`} />
      ),
      confirmText: 'Remove',
      onConfirm: async () => {
        try {
          await upsertPadConfiguration({
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
            name: undefined,
            audioFileId: undefined,
            keyBinding: config.keyBinding
          });
          await refreshPadConfigs();
          console.log(`Removed sound from pad ${padIndex}`);
        } catch (error) {
          console.error(`Failed to remove sound from pad ${padIndex}:`, error);
          alert(`Failed to remove sound "${soundName}". Please try again.`);
        } finally {
          closeModal();
          // No need to handle setEditing or shift key here as removal doesn't depend on it
        }
      },
      // onCancel is handled by default closeModal
    });
  };

  const handlePadClick = (padIndex: number, isShiftClick: boolean = false) => { // Removed async
    // If in edit mode and Delete key is pressed, handle removing sound
    if (isEditMode && isDeleteKeyDown) {
      const config = padConfigs.get(padIndex);
      if (config?.audioFileId) {
        handleRemoveSound(padIndex);
        return;
      }
    }
    // In edit mode with shift pressed, handle renaming
    if (isEditMode && isShiftClick) {
      const config = padConfigs.get(padIndex);
      const currentName = config?.name || `Pad ${padIndex + 1}`; // Default name if not configured

      // Variable to hold the new name from the modal
      let modalDataValue = currentName;

      // Set editing state to true before opening modal
      setEditing(true);

      openModal({
        title: 'Rename Pad',
        content: (
          <PromptModalContent
            label="Enter new name for pad:"
            initialValue={currentName}
            onValueChange={(value) => {
              modalDataValue = value;
            }}
          />
        ),
        confirmText: 'Rename',
        onConfirm: async () => {
          const newName = modalDataValue;
          // If the user enters an empty string, keep the old name
          const finalName = newName.trim() || currentName; 

          // Only update if name actually changed (or if it was default)
          if (finalName !== currentName || !config?.name) {
            try {
              if (activeProfileId !== null) {
                await upsertPadConfiguration({
                  profileId: activeProfileId,
                  pageIndex: currentPageIndex,
                  padIndex: padIndex,
                  name: finalName,
                  audioFileId: config?.audioFileId, // Keep existing audio/keybinding
                  keyBinding: config?.keyBinding
                });
                await refreshPadConfigs();
                console.log(`Renamed pad ${padIndex} to "${finalName}"`);
              } else {
                 console.error("Cannot rename pad, no active profile.");
                 alert("Cannot rename pad, no active profile selected.");
              }
            } catch (error) {
              console.error(`Failed to rename pad ${padIndex}:`, error);
              alert(`Failed to rename pad ${padIndex}. Please try again.`);
            } finally {
              closeModal();
              // Set editing state back. The listener will handle isEditMode.
              setEditing(false);
            }
          } else {
            // Name didn't change, just close modal and handle editing state
            closeModal();
            setEditing(false);
          }
        },
        onCancel: () => {
          // Set editing state back on cancel
          setEditing(false);
          // closeModal is handled by the store automatically
        }
      });
      return; // Prevent playback logic when renaming
    }

    // --- Regular playback functionality (only if not renaming/removing) ---
    // Resume AudioContext on first interaction
    if (!hasInteracted.current) {
        resumeAudioContext();
        hasInteracted.current = true;
    }

    const config = padConfigs.get(padIndex); // Get config again (might have changed if rename happened, though unlikely due to return)
    const playbackKey = `pad-${activeProfileId}-${currentPageIndex}-${padIndex}`; // Unique key

    // Check if this pad is currently playing
    if (playingPads.has(padIndex)) {
      // Stop currently playing sound if the same pad is clicked again
      stopAudio(playbackKey);
      console.log(`Stopped playback for pad index: ${padIndex}`);
    } else if (config?.audioFileId && activeProfileId !== null) { // Ensure profileId is not null
      // Play new sound
      console.log(`Attempting to play audio for pad index: ${padIndex}, file ID: ${config.audioFileId}`);

      // Use an async IIFE to handle audio loading/playing without making handlePadClick async
      (async () => {
        try {
          let buffer = audioBufferCache.get(config.audioFileId as number); // Type assertion
          if (!buffer) {
            console.log(`Audio buffer not in cache for file ID: ${config.audioFileId}. Loading...`);
            buffer = await loadAndDecodeAudio(config.audioFileId as number); // Type assertion
            if (buffer) {
              audioBufferCache.set(config.audioFileId as number, buffer); // Type assertion
              console.log(`Audio buffer cached for file ID: ${config.audioFileId}`);
            }
          } else {
              console.log(`Audio buffer retrieved from cache for file ID: ${config.audioFileId}`);
          }

          if (buffer) {
            playAudio(
              buffer,
              playbackKey,
              {
                name: config.name || `Pad ${padIndex + 1}`,
                padInfo: {
                  profileId: activeProfileId, // No need for assertion here
                  pageIndex: currentPageIndex,
                  padIndex: padIndex
                }
              }
            );
            // State updates (playingPads, padProgress) are handled by the useEffect hook listening to getActiveTracks
          } else {
            console.error(`Failed to load or decode audio for file ID: ${config.audioFileId}`);
          }
        } catch (error) {
          console.error(`Error during playback for pad index ${padIndex}:`, error);
        }
      })(); // Immediately invoke the async function

    } else {
      console.log(`Pad index ${padIndex} has no audio configured or no active profile.`);
      // Optionally provide feedback for empty pads
    }
  };

  // Handler for dropping audio files onto a pad
  const handleDropAudio = useCallback(async (acceptedFiles: File[], padIndex: number) => {
    if (!activeProfileId) {
        console.error("Cannot add audio, no active profile selected.");
        // TODO: Show user feedback
        return;
    }
    if (acceptedFiles.length === 0) {
        return;
    }
    const file = acceptedFiles[0]; // Handle only the first file dropped
    console.log(`Audio file dropped on pad index ${padIndex}:`, file.name, file.type);

    // Basic validation (can be expanded)
    if (!file.type.startsWith('audio/')) {
        console.error("Invalid file type dropped:", file.type);
        // TODO: Show user feedback
        return;
    }

    try {
        // 1. Add audio blob to DB
        const audioFileId = await addAudioFile({
            blob: file,
            name: file.name,
            type: file.type,
        });
        console.log(`Audio file added to DB with ID: ${audioFileId}`);

        // 2. Update pad configuration
        const newPadConfig: Omit<PadConfiguration, 'id' | 'createdAt' | 'updatedAt'> = {
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
            audioFileId: audioFileId,
            name: file.name.replace(/\.[^/.]+$/, ""), // Use filename without extension as default name
            // keyBinding: undefined, // Optionally clear keybinding or keep existing
        };
        await upsertPadConfiguration(newPadConfig);
        console.log(`Pad configuration updated for pad index ${padIndex}`);

        // 3. Refresh the grid UI to show the new configuration
        await refreshPadConfigs();

        // 4. Optional: Pre-cache the newly added audio buffer
        const buffer = await loadAndDecodeAudio(audioFileId);
        if (buffer) {
            audioBufferCache.set(audioFileId, buffer);
            console.log(`Pre-cached audio buffer for new file ID: ${audioFileId}`);
        }

    } catch (error) {
        console.error(`Error processing dropped file for pad index ${padIndex}:`, error);
        // TODO: Show user feedback
    }
  }, [activeProfileId, currentPageIndex, refreshPadConfigs]);


  // Always render the grid with the current pad configurations
  // Don't use a different loading placeholder, which causes flickering

  // Generate pad elements based on loaded configs or defaults
  const padElements = Array.from({ length: totalPads }, (_, i) => {
      const padIndex = i;
      const config = padConfigs.get(padIndex);
      const padId = `pad-${activeProfileId ?? 'none'}-${currentPageIndex}-${padIndex}`;
      const isPlaying = playingPads.has(padIndex);
      // Get detailed playback state if available
      const currentPlaybackState = padPlaybackState.get(padIndex);
      const progress = currentPlaybackState?.progress ?? 0;
      const remainingTime = currentPlaybackState?.remainingTime; // Will be undefined if not playing/tracked

      return (
          <Pad
              key={padId}
              id={padId}
              padIndex={padIndex} // Pass index
              profileId={activeProfileId} // Pass profile ID
              pageIndex={currentPageIndex} // Pass page index
              keyBinding={config?.keyBinding}
              name={config?.name}
              isConfigured={!!config?.audioFileId}
              isPlaying={isPlaying}
              playProgress={progress} // Pass the progress
              remainingTime={remainingTime} // Pass remaining time
              isEditMode={isEditMode} // Pass edit mode state
              onClick={() => handlePadClick(padIndex, false)}
              onShiftClick={() => handlePadClick(padIndex, true)}
              onDropAudio={handleDropAudio} // Pass drop handler
              onRemoveSound={config?.audioFileId ? () => handleRemoveSound(padIndex) : undefined} // Only provide handler if pad has sound
          />
      );
  });


  return (
    <div
      className="grid gap-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg shadow"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {/* Render the generated pad elements */}
      {padElements}
    </div>
  );
};

export default PadGrid;
