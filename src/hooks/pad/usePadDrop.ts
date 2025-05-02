/**
 * Hook for pad drop functionality
 *
 * Handles dropping audio files onto pads
 *
 * @module hooks/pad/usePadDrop
 */

import { useCallback } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  addAudioFile,
  isEmergencyPage,
  upsertPadConfiguration,
} from "@/lib/db";
import { loadAndDecodeAudio } from "@/lib/audio/decoder";

/**
 * Hook that provides pad drop functionality
 *
 * @param currentPageIndex - The current page/bank index
 * @param refreshPadConfigs - Function to refresh pad configurations
 * @returns Object containing handler for dropping audio files
 */
export function usePadDrop(
  currentPageIndex: number,
  refreshPadConfigs: () => void,
) {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const incrementEmergencySoundsVersion = useProfileStore(
    (state) => state.incrementEmergencySoundsVersion,
  );

  /**
   * Handler for dropping audio files onto a pad
   *
   * @param acceptedFiles - Array of files dropped onto the pad
   * @param padIndex - Index of the pad receiving the drop
   */
  const handleDropAudio = useCallback(
    async (acceptedFiles: File[], padIndex: number) => {
      if (activeProfileId === null) {
        console.error("Cannot add audio, no active profile selected.");
        return;
      }

      if (acceptedFiles.length === 0) {
        console.log("No files were dropped.");
        return;
      }

      const file = acceptedFiles[0]; // Take the first file when dropping directly onto a pad

      if (!file.type.startsWith("audio/")) {
        console.error(`Invalid file type dropped: ${file.type}`);
        return;
      }

      try {
        // Add the audio file to the database and get its ID
        const audioFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });

        // Create a pad configuration with the new audio file
        await upsertPadConfiguration({
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex: padIndex,
          audioFileIds: [audioFileId], // Single audio file in array
          playbackType: "round-robin", // Default playback type for single drop
          name: file.name.replace(/\.[^/.]+$/, ""), // Set default name (without extension)
        });

        // Refresh the UI
        refreshPadConfigs();

        // Check if we're on an emergency page and refresh if needed
        const isEmergency = await isEmergencyPage(
          activeProfileId,
          currentPageIndex,
        );
        if (isEmergency) {
          incrementEmergencySoundsVersion();
          console.log(`Emergency page ${currentPageIndex} updated after drop`);
        }

        // Preload the audio file to ensure it's ready to play
        await loadAndDecodeAudio(audioFileId);
        console.log(
          `Audio file ${file.name} added to pad ${padIndex} and preloaded`,
        );
      } catch (error) {
        console.error(
          `Error processing dropped file for pad ${padIndex}:`,
          error,
        );
        alert(`Failed to add audio file "${file.name}". Please try again.`);
      }
    },
    [
      activeProfileId,
      currentPageIndex,
      refreshPadConfigs,
      incrementEmergencySoundsVersion,
    ],
  );

  /**
   * Checks if file dropping is allowed for a pad
   *
   * @param padIndex - Index of the pad to check
   * @param audioFileCount - Number of audio files currently assigned to the pad
   * @param isSpecialPad - Whether the pad is a special control pad
   * @returns True if dropping is allowed, false otherwise
   */
  const isDropAllowed = useCallback(
    (
      padIndex: number,
      audioFileCount: number,
      isSpecialPad: boolean,
    ): boolean => {
      // Cannot drop onto special pads (Stop All, Fade Out All)
      if (isSpecialPad) {
        return false;
      }

      // Only allow drops on empty pads or pads with exactly one sound
      // (for pads with multiple sounds, use the edit modal instead)
      return audioFileCount <= 1;
    },
    [],
  );

  return {
    handleDropAudio,
    isDropAllowed,
  };
}
