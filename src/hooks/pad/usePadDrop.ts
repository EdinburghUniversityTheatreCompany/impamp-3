/**
 * Hook for pad drop functionality
 *
 * Handles dropping audio files onto pads
 *
 * @module hooks/pad/usePadDrop
 */

import { useCallback } from "react";
import { useProfileStore } from "@/store/profileStore";
import { addOrReuseAudioFile, DEFAULT_PLAYBACK_TYPE } from "@/lib/db";
import { savePadConfiguration } from "./padWrites";
import { loadAndDecodeAudio } from "@/lib/audio/decoder";

/**
 * Hook that provides pad drop functionality
 *
 * @param currentBankId - The identity of the current bank
 * @returns Object containing handler for dropping audio files
 */
export function usePadDrop(currentBankId: string) {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
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
        // The same sting dropped on a second pad, or a second bank, must name
        // one row.
        const { id: audioFileId } = await addOrReuseAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });

        // Create a pad configuration with the new audio file, and tell the
        // rest of the app. One call: the version bump the grid, the keyboard
        // and the emergency set all watch, and the sync request, are the
        // single tail every pad write shares — see `padWrites`.
        await savePadConfiguration({
          profileId: activeProfileId,
          bankId: currentBankId,
          padIndex: padIndex,
          audioFileIds: [audioFileId], // Single audio file in array
          playbackType: DEFAULT_PLAYBACK_TYPE,
          name: file.name.replace(/\.[^/.]+$/, ""), // Set default name (without extension)
        });

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
    [activeProfileId, currentBankId],
  );

  /**
   * Why a pad refuses a dropped file, or null when it accepts one.
   *
   * A reason rather than a boolean because the refusal has to be *said*. The
   * dropzone is only `disabled` for special pads and delete/move mode, so
   * react-dropzone still fires for every other refusal, the handler still
   * runs, and the file used to go nowhere without a word — while every other
   * refusal on this path logs or alerts. A drop in the few milliseconds after
   * a profile switch, while `canEdit` is still settling, lands here.
   *
   * One function rather than a predicate beside a message: the same rule
   * written twice is this repo's characteristic regression, and a refusal that
   * named the wrong reason would be worse than the silence it replaced.
   *
   * @param audioFileCount - Number of audio files currently assigned to the pad
   * @param isSpecialPad - Whether the pad is a special control pad
   * @returns A sentence fragment naming the reason, or null if the drop is allowed
   */
  const dropRefusalReason = useCallback(
    (audioFileCount: number, isSpecialPad: boolean): string | null => {
      // Cannot drop onto special pads (Stop All, Fade Out All)
      if (isSpecialPad) {
        return "it is a control pad";
      }

      // A followed or view-only profile takes no new sounds. Said here as well
      // as in the handler so the drop overlay never invites a drop that is
      // going to be refused.
      if (!canEdit) {
        return "this profile does not accept changes";
      }

      // Only allow drops on empty pads or pads with exactly one sound
      // (for pads with multiple sounds, use the edit modal instead)
      if (audioFileCount > 1) {
        return `it already holds ${audioFileCount} sounds — use the pad editor to add another`;
      }

      return null;
    },
    [canEdit],
  );

  return {
    handleDropAudio,
    dropRefusalReason,
  };
}
