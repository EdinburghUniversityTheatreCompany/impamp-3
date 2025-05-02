/**
 * Hook for pad swap functionality
 *
 * Handles swapping pads in delete/move mode
 *
 * @module hooks/pad/usePadSwap
 */

import { useCallback } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  PadConfiguration,
  isEmergencyPage,
  upsertPadConfiguration,
} from "@/lib/db";

interface PadSwapParams {
  currentPageIndex: number;
  padConfigs: Map<number, PadConfiguration>;
  refreshPadConfigs: () => void;
  specialPadIndices: number[];
}

/**
 * Hook that provides pad swap functionality
 *
 * @param params - Parameters for pad swap
 * @returns Object containing handler for swapping pads
 */
export function usePadSwap(params: PadSwapParams) {
  const { currentPageIndex, padConfigs, refreshPadConfigs, specialPadIndices } =
    params;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const incrementEmergencySoundsVersion = useProfileStore(
    (state) => state.incrementEmergencySoundsVersion,
  );

  /**
   * Handler for swapping pads in delete/move mode
   *
   * @param fromIndex - Source pad index
   * @param toIndex - Destination pad index
   */
  const handleSwapPads = useCallback(
    async (fromIndex: number, toIndex: number) => {
      if (activeProfileId === null) {
        console.error("Cannot swap pads, no active profile selected.");
        return;
      }

      const fromConfig = padConfigs.get(fromIndex);
      const toConfig = padConfigs.get(toIndex);

      // Cannot swap if either pad is a special control pad
      if (
        specialPadIndices.includes(fromIndex) ||
        specialPadIndices.includes(toIndex)
      ) {
        console.log("Cannot swap special control pads");
        return;
      }

      // If source pad is empty, nothing to move
      if (
        !fromConfig ||
        !fromConfig.audioFileIds ||
        fromConfig.audioFileIds.length === 0
      ) {
        console.log("Source pad is empty, nothing to move");
        return;
      }

      try {
        // Create temporary copies of the configurations to avoid reference issues
        const fromConfigCopy = fromConfig ? { ...fromConfig } : null;
        const toConfigCopy = toConfig ? { ...toConfig } : null;

        // STEP 1: First, clear both pads to avoid unique constraint errors
        // Clear the source pad (always has a configuration)
        await upsertPadConfiguration({
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex: fromIndex,
          audioFileIds: [], // Empty
          playbackType: "round-robin",
          name: undefined,
          keyBinding: undefined,
        });

        // Only clear the target pad if it has a configuration
        if (
          toConfigCopy &&
          toConfigCopy.audioFileIds &&
          toConfigCopy.audioFileIds.length > 0
        ) {
          await upsertPadConfiguration({
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: toIndex,
            audioFileIds: [], // Empty
            playbackType: "round-robin",
            name: undefined,
            keyBinding: undefined,
          });
        }

        // STEP 2: Now that both are empty, set up the new configurations
        // Move the from pad configuration to the target position, ensuring required fields are present
        await upsertPadConfiguration({
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex: toIndex,
          audioFileIds: fromConfigCopy?.audioFileIds || [],
          playbackType: fromConfigCopy?.playbackType || "round-robin",
          name: fromConfigCopy?.name,
          keyBinding: fromConfigCopy?.keyBinding,
        });

        // If the target had a configuration, move it to the source position
        if (
          toConfigCopy &&
          toConfigCopy.audioFileIds &&
          toConfigCopy.audioFileIds.length > 0
        ) {
          await upsertPadConfiguration({
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: fromIndex,
            audioFileIds: toConfigCopy.audioFileIds,
            playbackType: toConfigCopy.playbackType || "round-robin",
            name: toConfigCopy.name,
            keyBinding: toConfigCopy.keyBinding,
          });
        }

        // Success - refresh grid and update emergency sounds if needed
        refreshPadConfigs();
        console.log(`Successfully swapped pads ${fromIndex} and ${toIndex}`);

        // Check if we're on an emergency page and refresh if needed
        const isEmergency = await isEmergencyPage(
          activeProfileId,
          currentPageIndex,
        );
        if (isEmergency) {
          incrementEmergencySoundsVersion();
        }
      } catch (error) {
        console.error(
          `Failed to swap pads ${fromIndex} and ${toIndex}:`,
          error,
        );
        alert(`Failed to swap pads. Please try again.`);
      }
    },
    [
      activeProfileId,
      currentPageIndex,
      padConfigs,
      refreshPadConfigs,
      specialPadIndices,
      incrementEmergencySoundsVersion,
    ],
  );

  return {
    handleSwapPads,
  };
}
