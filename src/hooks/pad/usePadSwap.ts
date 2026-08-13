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
  swapPadConfigurations,
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
  const requestSync = useProfileStore((state) => state.requestSync);

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
        // Both pads are rewritten in a single transaction, so the sounds can
        // never end up assigned to neither pad
        await swapPadConfigurations(
          activeProfileId,
          currentPageIndex,
          fromIndex,
          toIndex,
        );

        // Success - refresh grid and update emergency sounds if needed
        refreshPadConfigs();
        requestSync(activeProfileId);
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
      requestSync,
    ],
  );

  return {
    handleSwapPads,
  };
}
