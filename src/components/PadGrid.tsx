'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Pad from './Pad';
import { useProfileStore } from '@/store/profileStore';
import {
  getPadConfigurationsForProfilePage,
  PadConfiguration,
  addAudioFile,
  upsertPadConfiguration,
} from '@/lib/db';
import { loadAndDecodeAudio, playAudio, stopAudio, resumeAudioContext } from '@/lib/audio';
// useDropzone will be used in Pad component

interface PadGridProps {
  rows?: number;
  cols?: number;
  currentPageIndex?: number; // Add page index prop
}

// Cache for decoded audio buffers to avoid re-decoding
const audioBufferCache = new Map<number, AudioBuffer | null>(); // Allow null for failed decodes

const PadGrid: React.FC<PadGridProps> = ({ rows = 4, cols = 8, currentPageIndex = 0 }) => {
  const totalPads = rows * cols;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const [padConfigs, setPadConfigs] = useState<Map<number, PadConfiguration>>(new Map()); // Map padIndex to config
  const [isLoading, setIsLoading] = useState(true);
  const [playingPadIndex, setPlayingPadIndex] = useState<number | null>(null);
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


  useEffect(() => {
    const loadConfigs = async () => {
      if (activeProfileId === null) {
        setPadConfigs(new Map());
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        console.log(`Loading pad configs for profile ${activeProfileId}, page ${currentPageIndex}`);
        const configs = await getPadConfigurationsForProfilePage(activeProfileId, currentPageIndex);
        const configMap = new Map<number, PadConfiguration>();
        configs.forEach(config => {
          configMap.set(config.padIndex, config);
        });
        setPadConfigs(configMap);
        console.log(`Loaded ${configs.length} pad configs.`);
      } catch (error) {
        console.error("Failed to load pad configurations:", error);
        // Handle error state in UI?
      } finally {
        setIsLoading(false);
      }
    };

    loadConfigs();
  }, [activeProfileId, currentPageIndex, refreshPadConfigs]); // Add refreshPadConfigs dependency

  const handlePadClick = async (padIndex: number) => {
    // Resume AudioContext on first interaction
    if (!hasInteracted.current) {
        resumeAudioContext();
        hasInteracted.current = true;
    }

    const config = padConfigs.get(padIndex);
    const playbackKey = `pad-${activeProfileId}-${currentPageIndex}-${padIndex}`; // Unique key

    if (playingPadIndex === padIndex) {
      // Stop currently playing sound if the same pad is clicked again
      stopAudio(playbackKey);
      setPlayingPadIndex(null);
      console.log(`Stopped playback for pad index: ${padIndex}`);
    } else if (config?.audioFileId) {
      // Play new sound
      setPlayingPadIndex(padIndex); // Visually indicate playback start
      console.log(`Attempting to play audio for pad index: ${padIndex}, file ID: ${config.audioFileId}`);

      try {
        let buffer = audioBufferCache.get(config.audioFileId);
        if (!buffer) {
          console.log(`Audio buffer not in cache for file ID: ${config.audioFileId}. Loading...`);
          buffer = await loadAndDecodeAudio(config.audioFileId);
          if (buffer) {
            audioBufferCache.set(config.audioFileId, buffer);
            console.log(`Audio buffer cached for file ID: ${config.audioFileId}`);
          }
        } else {
            console.log(`Audio buffer retrieved from cache for file ID: ${config.audioFileId}`);
        }

        if (buffer) {
          const source = playAudio(buffer, playbackKey);
          if (source) {
            // Use the 'onended' event from the source to clear the playing state
            source.onended = () => {
              setPlayingPadIndex((currentIndex) =>
                currentIndex === padIndex ? null : currentIndex
              );
              console.log(`Playback naturally ended for pad index: ${padIndex}`);
            };
          } else {
             // Playback failed to start
             setPlayingPadIndex(null);
          }
        } else {
          console.error(`Failed to load or decode audio for file ID: ${config.audioFileId}`);
          setPlayingPadIndex(null); // Clear playing state if audio fails
        }
      } catch (error) {
        console.error(`Error during playback for pad index ${padIndex}:`, error);
        setPlayingPadIndex(null); // Clear playing state on error
      }
    } else {
      console.log(`Pad index ${padIndex} has no audio configured.`);
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


  if (isLoading) {
    return <div className="text-center p-10">Loading pad configurations...</div>;
  }

  // Generate pad elements based on loaded configs or defaults
  const padElements = Array.from({ length: totalPads }, (_, i) => {
      const padIndex = i;
      const config = padConfigs.get(padIndex);
      const padId = `pad-${activeProfileId ?? 'none'}-${currentPageIndex}-${padIndex}`;

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
              isPlaying={playingPadIndex === padIndex}
              onClick={() => handlePadClick(padIndex)}
              onDropAudio={handleDropAudio} // Pass drop handler
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
