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
  DEFAULT_PLAYBACK_TYPE,
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
  const incrementPadConfigsVersion = useProfileStore(
    (state) => state.incrementPadConfigsVersion,
  );
  const requestSync = useProfileStore((state) => state.requestSync);
  // Dropping a file is a write, and it is the one write that needs no edit
  // mode — so none of the Shift-key gates cover it. On a profile that cannot
  // push, the sound would be added locally and then deleted by the next sync
  // applying the remote state over it.
  const canEdit = useProfileStore((state) => state.canEditActiveProfile());

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

      // Read fresh rather than trusting the render-time value: a sync can
      // learn mid-drag that the remote has stopped accepting our writes.
      if (!useProfileStore.getState().canEditActiveProfile()) {
        console.warn("Cannot add audio: this profile does not accept changes.");
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
          playbackType: DEFAULT_PLAYBACK_TYPE,
          name: file.name.replace(/\.[^/.]+$/, ""), // Set default name (without extension)
        });

        // Refresh the UI
        refreshPadConfigs();
        incrementPadConfigsVersion();
        requestSync(activeProfileId);

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
      incrementPadConfigsVersion,
      requestSync,
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

      // A followed or view-only profile takes no new sounds. Said here as well
      // as in the handler so the drop overlay never invites a drop that is
      // going to be refused.
      // A followed or view-only profile takes no new sounds. Said here as well
      // as in the handler so the drop overlay never invites a drop that is
      // going to be refused.
      if (!canEdit) {
        return false;
      }

      // Only allow drops on empty pads or pads with exactly one sound
      // (for pads with multiple sounds, use the edit modal instead)
      return audioFileCount <= 1;
    },
    [canEdit],
  );

  return {
    handleDropAudio,
    isDropAllowed,
  };
}
