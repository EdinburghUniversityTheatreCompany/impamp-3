/**
 * Hook for pad interaction logic
 *
 * Handles various pad interactions like playback, editing, and removing
 *
 * @module hooks/pad/usePadInteractions
 */

import { useCallback } from "react";
import { useProfileStore } from "@/store/profileStore";
import { useUIStore } from "@/store/uiStore";
import {
  PadConfiguration,
  isEmergencyPage,
  upsertPadConfiguration,
} from "@/lib/db";
import {
  triggerAudioForPadInstant,
  ensureAudioContextActive,
  LoadingState,
} from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import {
  loadingStoreActions,
  generatePadLoadingKey,
} from "@/store/loadingStore";
import EditPadModalContent, {
  EditPadModalContentRef,
} from "@/components/modals/EditPadModalContent";
import ConfirmModalContent from "@/components/modals/ConfirmModalContent";
import React from "react";

interface PadInteractionsParams {
  currentPageIndex: number;
  padConfigs: Map<number, PadConfiguration>;
  refreshPadConfigs: () => void;
  editModalRef: React.RefObject<EditPadModalContentRef>;
  hasInteracted: React.RefObject<boolean>;
}

/**
 * Hook that provides interaction handlers for pads
 *
 * @param params - Parameters for pad interactions
 * @returns Object containing handlers for pad interactions
 */
export function usePadInteractions(params: PadInteractionsParams) {
  const {
    currentPageIndex,
    padConfigs,
    refreshPadConfigs,
    editModalRef,
    hasInteracted,
  } = params;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const incrementEmergencySoundsVersion = useProfileStore(
    (state) => state.incrementEmergencySoundsVersion,
  );
  const { openModal, closeModal } = useUIStore();

  /**
   * Handles opening the edit modal for multi-sound configuration
   */
  const handleEditInteraction = useCallback(
    (padIndex: number) => {
      if (activeProfileId === null) {
        console.error("Cannot edit pad, no active profile.");
        alert("Cannot edit pad, no active profile selected.");
        return;
      }

      const padConfig = padConfigs.get(padIndex);

      // Create a default config if editing an empty pad
      const initialConfig: PadConfiguration = padConfig ?? {
        profileId: activeProfileId,
        pageIndex: currentPageIndex,
        padIndex: padIndex,
        audioFileIds: [],
        playbackType: "round-robin",
        createdAt: new Date(), // Temporary, won't be saved like this
        updatedAt: new Date(), // Temporary
        // name and keyBinding will be handled by EditPadModalContent defaults/state
      };

      // Handler for save confirmation
      const handleSaveConfirm = async () => {
        if (!editModalRef.current) {
          console.error("Edit modal ref not available on confirm.");
          closeModal(); // Close modal even on error
          return;
        }

        try {
          // Get the latest state from the modal content via the ref
          const updatedPadConfigData = editModalRef.current.getCurrentState();

          // Upsert the configuration with the data from the modal state
          await upsertPadConfiguration(updatedPadConfigData);
          refreshPadConfigs(); // Refresh the grid display
          console.log(
            `Saved changes for pad ${padIndex}`,
            updatedPadConfigData,
          );

          const isEmergency = await isEmergencyPage(
            activeProfileId,
            currentPageIndex,
          );
          if (isEmergency) {
            incrementEmergencySoundsVersion();
            console.log(
              `Pad renamed on emergency page ${currentPageIndex}, triggered emergency sounds refresh`,
            );
          }
        } catch (error) {
          console.error(`Failed to save changes for pad ${padIndex}:`, error);
          alert(
            `Failed to save changes for pad ${padIndex}. Please try again.`,
          );
        } finally {
          closeModal(); // Close the modal regardless of success/error
        }
      };

      // Open the modal with the Edit Pad component content
      openModal({
        title: "Edit Pad",
        content: React.createElement(EditPadModalContent, {
          ref: editModalRef,
          initialPadConfig: initialConfig,
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex: padIndex,
        }),
        confirmText: "Save Changes",
        onConfirm: handleSaveConfirm,
      });
    },
    [
      activeProfileId,
      currentPageIndex,
      padConfigs,
      refreshPadConfigs,
      incrementEmergencySoundsVersion,
      openModal,
      closeModal,
      editModalRef,
    ],
  );

  /**
   * Handles removing sound(s) or opening edit modal if multiple sounds exist
   */
  const handleRemoveInteraction = useCallback(
    (padIndex: number) => {
      const config = padConfigs.get(padIndex);

      // Check if config exists and has sounds
      if (
        !config ||
        !config.audioFileIds ||
        config.audioFileIds.length === 0 ||
        activeProfileId === null
      ) {
        console.warn(
          `[handleRemoveInteraction] No config or sounds found for pad ${padIndex}`,
        );
        return;
      }

      // If more than one sound, open the edit modal instead of direct removal
      if (config.audioFileIds.length > 1) {
        console.log(
          `[handleRemoveInteraction] Multiple sounds found for pad ${padIndex}, opening edit modal.`,
        );
        handleEditInteraction(padIndex); // Delegate to edit handler
        return;
      }

      // For single sound removal
      const soundName = config.name || `Pad ${padIndex + 1}`;

      // Handler for confirmation
      const handleConfirm = async () => {
        try {
          if (activeProfileId === null) {
            throw new Error("Invalid Profile ID for removal");
          }

          // Update config to have empty audioFileIds and default playbackType
          await upsertPadConfiguration({
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
            name: undefined, // Reset name to default
            audioFileIds: [], // Clear the sounds
            playbackType: "round-robin", // Reset playback type
            keyBinding: config.keyBinding, // Keep existing keybinding
          });
          refreshPadConfigs();
          console.log(`Removed single sound from pad ${padIndex}`);

          const isEmergency = await isEmergencyPage(
            activeProfileId,
            currentPageIndex,
          );
          if (isEmergency) {
            incrementEmergencySoundsVersion();
            console.log(
              `Pad removed on emergency page ${currentPageIndex}, triggered emergency sounds refresh`,
            );
          }
        } catch (error) {
          console.error(`Failed to remove sound from pad ${padIndex}:`, error);
          alert(`Failed to remove sound "${soundName}". Please try again.`);
        } finally {
          closeModal();
        }
      };

      // Open the modal with proper configuration
      openModal({
        title: "Remove Sound",
        content: React.createElement(ConfirmModalContent, {
          message: `Remove sound "${soundName}" from this pad?`,
        }),
        confirmText: "Remove",
        onConfirm: handleConfirm,
      });
    },
    [
      activeProfileId,
      currentPageIndex,
      padConfigs,
      refreshPadConfigs,
      incrementEmergencySoundsVersion,
      openModal,
      closeModal,
      handleEditInteraction,
    ],
  );

  /**
   * Handles starting/stopping playback with instant response
   */
  const handlePlaybackInteraction = useCallback(
    (padConfig: PadConfiguration) => {
      if (activeProfileId === null) return;

      if (!hasInteracted.current) {
        ensureAudioContextActive();
        hasInteracted.current = true;
      }

      // Use instant trigger with loading state callbacks
      triggerAudioForPadInstant({
        padIndex: padConfig.padIndex,
        audioFileIds: padConfig.audioFileIds,
        playbackType: padConfig.playbackType,
        activeProfileId: activeProfileId,
        currentPageIndex: currentPageIndex,
        name: padConfig.name,
        onInstantFeedback: () => {
          console.log(
            `[Pad Interactions] Instant feedback for pad ${padConfig.padIndex}`,
          );
          // Pad clicked feedback is immediate
        },
        onLoadingStateChange: (state: LoadingState) => {
          console.log(
            `[Pad Interactions] Loading state for pad ${padConfig.padIndex}:`,
            state.status,
            `${Math.round((state.progress || 0) * 100)}%`,
          );
          if (activeProfileId === null) return;
          const loadingKey = generatePadLoadingKey(
            activeProfileId,
            currentPageIndex,
            padConfig.padIndex,
          );
          loadingStoreActions.setPadLoadingState(loadingKey, state);
        },
        onAudioReady: () => {
          console.log(
            `[Pad Interactions] Audio ready for pad ${padConfig.padIndex}`,
          );
          // Clear loading state when audio starts playing
          if (activeProfileId === null) return;
          const loadingKey = generatePadLoadingKey(
            activeProfileId,
            currentPageIndex,
            padConfig.padIndex,
          );
          loadingStoreActions.clearPadLoadingState(loadingKey);
        },
        onError: (error: string) => {
          console.error(
            `[Pad Interactions] Error for pad ${padConfig.padIndex}:`,
            error,
          );
          // Clear loading state on error
          if (activeProfileId === null) return;
          const loadingKey = generatePadLoadingKey(
            activeProfileId,
            currentPageIndex,
            padConfig.padIndex,
          );
          loadingStoreActions.clearPadLoadingState(loadingKey);
        },
      });
    },
    [activeProfileId, currentPageIndex, hasInteracted],
  );

  /**
   * Handler for arming a track on Ctrl+Click
   */
  const handleArmTrack = useCallback(
    (padIndex: number) => {
      if (activeProfileId === null) {
        console.error("Cannot arm track, no active profile selected.");
        return;
      }

      const config = padConfigs.get(padIndex);
      if (!config || !config.audioFileIds || config.audioFileIds.length === 0) {
        console.log(`Pad index ${padIndex} has no sounds to arm.`);
        return;
      }

      // Create a unique key for this armed track
      const armedKey = `armed-${activeProfileId}-${currentPageIndex}-${padIndex}`;

      // Add to armed tracks store
      playbackStoreActions.armTrack(armedKey, {
        key: armedKey,
        name: config.name || `Pad ${padIndex + 1}`,
        padInfo: {
          profileId: activeProfileId,
          pageIndex: currentPageIndex,
          padIndex: padIndex,
        },
        audioFileIds: config.audioFileIds,
        playbackType: config.playbackType || "round-robin",
      });

      console.log(`Armed track: ${config.name || `Pad ${padIndex + 1}`}`);
    },
    [activeProfileId, currentPageIndex, padConfigs],
  );

  return {
    handleRemoveInteraction,
    handleEditInteraction,
    handlePlaybackInteraction,
    handleArmTrack,
  };
}
