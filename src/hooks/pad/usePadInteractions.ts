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
  DEFAULT_PLAYBACK_TYPE,
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
  createPadEditSession,
} from "@/components/modals/EditPadModalContent";
import { useFormModal } from "@/hooks/modal/useFormModal";
import type { FormErrors } from "@/hooks/modal/useFormModal";
import type { PadFormValues } from "@/types/forms";
import { DEFAULT_PAD_NAME } from "@/lib/constants";
import ConfirmModalContent from "@/components/modals/ConfirmModalContent";
import React from "react";

interface PadInteractionsParams {
  currentPageIndex: number;
  padConfigs: Map<number, PadConfiguration>;
  refreshPadConfigs: () => void;
  hasInteractedRef: React.RefObject<boolean>;
}

/**
 * Hook that provides interaction handlers for pads
 *
 * @param params - Parameters for pad interactions
 * @returns Object containing handlers for pad interactions
 */
export function usePadInteractions(params: PadInteractionsParams) {
  const { currentPageIndex, padConfigs, refreshPadConfigs, hasInteractedRef } =
    params;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const incrementEmergencySoundsVersion = useProfileStore(
    (state) => state.incrementEmergencySoundsVersion,
  );
  const requestSync = useProfileStore((state) => state.requestSync);
  const { openModal, closeModal } = useUIStore();
  const { openFormModal } = useFormModal();

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
      const session = createPadEditSession();

      openFormModal<PadFormValues>({
        title: "Edit Pad",
        confirmText: "Save Changes",
        initialValues: {
          name: padConfig?.name || DEFAULT_PAD_NAME,
          playbackType: padConfig?.playbackType ?? DEFAULT_PLAYBACK_TYPE,
          audioFileIds: padConfig?.audioFileIds ?? [],
          audioTrimSettings: padConfig?.audioTrimSettings,
          audioGainSettings: padConfig?.audioGainSettings,
          padGainDb: padConfig?.padGainDb,
          isDisabled: padConfig?.isDisabled ?? false,
        },
        renderForm: (props) =>
          React.createElement(EditPadModalContent, {
            ...props,
            profileId: activeProfileId,
            session,
          }),
        validate: (values) => {
          const errors: FormErrors<PadFormValues> = {};
          if (!values.name.trim()) {
            errors.name = "Pad name is required";
          }
          return errors;
        },
        onSubmit: async (values) => {
          const updatedPadConfigData = {
            profileId: activeProfileId,
            pageIndex: currentPageIndex,
            padIndex,
            name: values.name,
            playbackType: values.playbackType,
            audioFileIds: values.audioFileIds,
            audioTrimSettings: values.audioTrimSettings,
            audioGainSettings: values.audioGainSettings,
            padGainDb: values.padGainDb,
            isDisabled: values.isDisabled,
            keyBinding: padConfig?.keyBinding, // Preserve original keybinding
          };

          try {
            await upsertPadConfiguration(updatedPadConfigData);
          } catch (error) {
            console.error(`Failed to save changes for pad ${padIndex}:`, error);
            alert(
              `Failed to save changes for pad ${padIndex}. Please try again.`,
            );
            // Rethrown so useFormModal keeps the modal open rather than
            // closing on a save that did not happen.
            throw error;
          }

          // The sounds added in this session are now referenced by a saved
          // pad, so the modal must not discard them when it unmounts.
          session.savedFileIds = values.audioFileIds;

          // A disabled pad must not stay queued as an armed cue, or F9 would
          // still fire it. Any sound already playing is left alone — disabling
          // blocks future triggers rather than cutting a live cue.
          if (updatedPadConfigData.isDisabled) {
            playbackStoreActions.removeArmedTrack(
              `armed-${activeProfileId}-${currentPageIndex}-${padIndex}`,
            );
          }

          // Reaches the grid and the keyboard alike — they read one source.
          refreshPadConfigs();
          requestSync(activeProfileId);

          if (await isEmergencyPage(activeProfileId, currentPageIndex)) {
            incrementEmergencySoundsVersion();
          }
        },
      });
    },
    [
      activeProfileId,
      currentPageIndex,
      padConfigs,
      refreshPadConfigs,
      incrementEmergencySoundsVersion,
      requestSync,
      openFormModal,
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
            playbackType: DEFAULT_PLAYBACK_TYPE, // Reset playback type
            isDisabled: false, // An emptied pad should not stay marked "Off"
            keyBinding: config.keyBinding, // Keep existing keybinding
          });
          refreshPadConfigs();
          requestSync(activeProfileId);
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
      requestSync,
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

      if (padConfig.isDisabled) {
        console.log(
          `Pad index ${padConfig.padIndex} is disabled, not playing.`,
        );
        return;
      }

      if (!hasInteractedRef.current) {
        ensureAudioContextActive();
        hasInteractedRef.current = true;
      }

      // Use instant trigger with loading state callbacks
      triggerAudioForPadInstant({
        padIndex: padConfig.padIndex,
        audioFileIds: padConfig.audioFileIds,
        playbackType: padConfig.playbackType,
        activeProfileId: activeProfileId,
        currentPageIndex: currentPageIndex,
        name: padConfig.name,
        audioTrimSettings: padConfig.audioTrimSettings,
        audioGainSettings: padConfig.audioGainSettings,
        padGainDb: padConfig.padGainDb,
        isDisabled: padConfig.isDisabled,
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
    [activeProfileId, currentPageIndex, hasInteractedRef],
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

      if (config.isDisabled) {
        console.log(`Pad index ${padIndex} is disabled, cannot arm.`);
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
        playbackType: config.playbackType || DEFAULT_PLAYBACK_TYPE,
        audioTrimSettings: config.audioTrimSettings,
        audioGainSettings: config.audioGainSettings,
        padGainDb: config.padGainDb,
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
