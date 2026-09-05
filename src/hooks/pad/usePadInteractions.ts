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
import { PadConfiguration, DEFAULT_PLAYBACK_TYPE } from "@/lib/db";
import { savePadConfiguration } from "./padWrites";
import { triggerPad, ensureAudioContextActive } from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { createPadEditSession } from "@/components/modals/padEditSession";
import { useFormModal } from "@/hooks/modal/useFormModal";
import type { FormErrors } from "@/hooks/modal/useFormModal";
import type { PadFormValues } from "@/types/forms";
import { DEFAULT_PAD_NAME } from "@/lib/constants";
import ConfirmModalContent from "@/components/modals/ConfirmModalContent";
import ModalLoadingSpinner from "@/components/modals/ModalLoadingSpinner";
import React from "react";

// Loaded when a pad is actually edited, not when the board is drawn.
//
// The editor's subtree reaches `EditPadForm`, which imports
// `@hello-pangea/dnd`; a static import from this hook put that whole library
// into the page's first-load graph — a `<script async>` on the prerendered
// document — for a modal most sessions never open. This is the `React.lazy`
// pattern `modalRegistry` already uses for the four large modals, not the
// `next/dynamic` one measured and rejected for `ProfileManager`
// (see `ProfileManagerHost`).
const EditPadModalContent = React.lazy(
  () => import("@/components/modals/EditPadModalContent"),
);
const EditPadModalFallback = () =>
  React.createElement(ModalLoadingSpinner, null);
import { extractPadPlaybackSettings } from "@/lib/db";
import { noticeActions, reportFailure } from "@/store/noticeStore";

interface PadInteractionsParams {
  currentBankId: string;
  padConfigs: Map<number, PadConfiguration>;
  hasInteractedRef: React.RefObject<boolean>;
}

/**
 * Hook that provides interaction handlers for pads
 *
 * @param params - Parameters for pad interactions
 * @returns Object containing handlers for pad interactions
 */
export function usePadInteractions(params: PadInteractionsParams) {
  const { currentBankId, padConfigs, hasInteractedRef } = params;
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  // Consumed by PadGrid, so a bare subscription meant opening *any* modal
  // re-rendered the grid's whole handler tree.
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const { openFormModal } = useFormModal();

  /**
   * Handles opening the edit modal for multi-sound configuration
   */
  const handleEditInteraction = useCallback(
    (padIndex: number) => {
      if (activeProfileId === null) {
        noticeActions.error("Cannot edit a pad: no active profile.");
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
          activePadBehavior: padConfig?.activePadBehavior,
        },
        // `renderForm`'s output is rendered as the modal's `content`, which
        // `ModalRenderer` does not wrap in a Suspense boundary — that one is
        // on the `modalType` path. So the boundary comes with the component.
        renderForm: (props) =>
          React.createElement(
            React.Suspense,
            { fallback: React.createElement(EditPadModalFallback) },
            React.createElement(EditPadModalContent, {
              ...props,
              session,
            }),
          ),
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
            bankId: currentBankId,
            padIndex,
            name: values.name,
            playbackType: values.playbackType,
            audioFileIds: values.audioFileIds,
            audioTrimSettings: values.audioTrimSettings,
            audioGainSettings: values.audioGainSettings,
            padGainDb: values.padGainDb,
            isDisabled: values.isDisabled,
            activePadBehavior: values.activePadBehavior,
            keyBinding: padConfig?.keyBinding, // Preserve original keybinding
          };

          try {
            await savePadConfiguration(updatedPadConfigData);
          } catch (error) {
            reportFailure(`Could not save pad ${padIndex + 1}`, error);
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
              `armed-${activeProfileId}-${currentBankId}-${padIndex}`,
            );
          }
        },
      });
    },
    [activeProfileId, currentBankId, padConfigs, openFormModal],
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
          await savePadConfiguration({
            profileId: activeProfileId,
            bankId: currentBankId,
            padIndex: padIndex,
            name: undefined, // Reset name to default
            audioFileIds: [], // Clear the sounds
            playbackType: DEFAULT_PLAYBACK_TYPE, // Reset playback type
            isDisabled: false, // An emptied pad should not stay marked "Off"
            // Explicitly undefined, not omitted: `upsertPadConfiguration`
            // merges `{...existing, ...padConfig}`, so omitting the key would
            // leave the old override on a pad that no longer has the sound it
            // was chosen for. Same reasoning as the two resets above.
            activePadBehavior: undefined,
            keyBinding: config.keyBinding, // Keep existing keybinding
          });
          console.log(`Removed single sound from pad ${padIndex}`);
        } catch (error) {
          reportFailure(
            `Could not remove "${soundName}" from pad ${padIndex + 1}`,
            error,
          );
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
      currentBankId,
      padConfigs,
      openModal,
      closeModal,
      handleEditInteraction,
    ],
  );

  /**
   * Handles starting/stopping playback with instant response
   */
  const handlePlaybackInteraction = useCallback(
    async (padConfig: PadConfiguration) => {
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

      await triggerPad(
        {
          ...extractPadPlaybackSettings(padConfig),
          padIndex: padConfig.padIndex,
        },
        { activeProfileId, currentBankId },
        { logPrefix: "[Pad Interactions]" },
      );
    },
    [activeProfileId, currentBankId, hasInteractedRef],
  );

  /**
   * Handler for arming a track on the arm chord — Ctrl+Click, or Cmd+Click on
   * a Mac. See `hasArmModifier` in `src/lib/platform.ts`.
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
      const armedKey = `armed-${activeProfileId}-${currentBankId}-${padIndex}`;

      // Add to armed tracks store
      playbackStoreActions.armTrack(armedKey, {
        // Through the one funnel, not a field list: an armed cue's snapshot is
        // read back through `extractPadPlaybackSettings` when the pad cannot
        // be re-read, so a field this literal forgot was defaulted rather than
        // played.
        ...extractPadPlaybackSettings(config),
        key: armedKey,
        name: config.name || `Pad ${padIndex + 1}`,
        padInfo: {
          profileId: activeProfileId,
          bankId: currentBankId,
          padIndex: padIndex,
        },
      });

      console.log(`Armed track: ${config.name || `Pad ${padIndex + 1}`}`);
    },
    [activeProfileId, currentBankId, padConfigs],
  );

  return {
    handleRemoveInteraction,
    handleEditInteraction,
    handlePlaybackInteraction,
    handleArmTrack,
  };
}
