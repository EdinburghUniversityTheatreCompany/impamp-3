"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Pad from "./Pad";
import { useProfileStore } from "@/store/profileStore";
import { useUIStore } from "@/store/uiStore";
import ConfirmModalContent from "./modals/ConfirmModalContent";
import EditPadModalContent, {
  EditPadModalContentRef,
} from "./modals/EditPadModalContent";
import { usePadConfigurations } from "@/hooks/usePadConfigurations";
import {
  PadConfiguration,
  addAudioFile,
  upsertPadConfiguration,
  isEmergencyPage,
} from "@/lib/db";
import {
  loadAndDecodeAudio,
  triggerAudioForPad,
  resumeAudioContext,
  stopAllAudio,
  fadeOutAllAudio,
  preloadAudioForPage,
} from "@/lib/audio";
import { usePlaybackStore } from "@/store/playbackStore";
import { GRID_COLS, GRID_ROWS, TOTAL_PADS } from "@/lib/constants";

// Define configuration for special pads
const SPECIAL_PAD_CONFIG = {
  STOP_ALL: {
    index: 1 * GRID_COLS + (GRID_COLS - 1),
    label: "Stop All",
    keyBinding: "Escape",
  }, // Row 2, last col
  FADE_OUT_ALL: {
    index: 2 * GRID_COLS + (GRID_COLS - 1),
    label: "Fade Out All",
    keyBinding: " ",
  }, // Row 3, last col
};

interface PadGridProps {
  currentPageIndex: number;
}

const PadGrid: React.FC<PadGridProps> = ({ currentPageIndex }) => {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const isEditMode = useProfileStore((state) => state.isEditMode);
  const incrementEmergencySoundsVersion = useProfileStore(
    (state) => state.incrementEmergencySoundsVersion,
  );
  const { openModal, closeModal } = useUIStore();
  const hasInteracted = useRef(false);
  const editModalRef = useRef<EditPadModalContentRef>(null); // Ref for the edit modal content

  // Use the hook to get pad configurations
  const {
    padConfigs,
    isLoading: isLoadingConfigs,
    error: configError,
    refetch: refreshPadConfigs,
  } = usePadConfigurations(
    activeProfileId !== null ? String(activeProfileId) : null,
    currentPageIndex,
  );

  // Subscribe to the playback store
  const activePlayback = usePlaybackStore((state) => state.activePlayback);

  // Log loading and error states
  useEffect(() => {
    if (isLoadingConfigs) {
      console.log("[PadGrid] Loading pad configurations...");
    }
    if (configError) {
      console.error("[PadGrid] Error loading pad configurations:", configError);
    }
  }, [isLoadingConfigs, configError]);

  // Preload audio effect
  useEffect(() => {
    if (activeProfileId === null || padConfigs.size === 0) return;
    // Pass the actual configurations to the updated preload function
    const configsArray = Array.from(padConfigs.values());
    if (configsArray.length > 0) {
      console.log(
        `[PadGrid Preload] Triggering preload for page ${currentPageIndex}`,
      );
      preloadAudioForPage(configsArray);
    }
  }, [padConfigs, activeProfileId, currentPageIndex]);

  // Delete key state tracking
  const [isDeleteKeyDown, setIsDeleteKeyDown] = useState(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete") setIsDeleteKeyDown(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Delete") setIsDeleteKeyDown(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // --- Refactored Interaction Handlers ---

  // Handles removing sound(s) or opening edit modal if multiple sounds exist
  const handleRemoveInteraction = (padIndex: number) => {
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
      handleEditInteraction(config, padIndex); // Delegate to edit handler
      return;
    }

    // --- Proceed with single sound removal ---
    const soundName = config.name || `Pad ${padIndex + 1}`;
    openModal({
      title: "Remove Sound", // Keep title generic
      content: (
        <ConfirmModalContent
          message={`Remove sound "${soundName}" from this pad?`}
        />
      ),
      confirmText: "Remove",
      onConfirm: async () => {
        try {
          const numericProfileId = activeProfileId;
          if (numericProfileId === null) {
            throw new Error("Invalid Profile ID for removal");
          }

          // Update config to have empty audioFileIds and default playbackType
          await upsertPadConfiguration({
            profileId: numericProfileId,
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
            numericProfileId,
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
      },
    });
  };

  // Handles opening the edit modal for multi-sound configuration
  const handleEditInteraction = (
    padConfig: PadConfiguration | null, // Can be null if editing an empty pad
    padIndex: number,
  ) => {
    if (activeProfileId === null) {
      console.error("Cannot edit pad, no active profile.");
      alert("Cannot edit pad, no active profile selected.");
      return;
    }
    const numericProfileId = activeProfileId; // Use validated ID

    // Create a default config if editing an empty pad
    const initialConfig = padConfig ?? {
      profileId: numericProfileId,
      pageIndex: currentPageIndex,
      padIndex: padIndex,
      audioFileIds: [],
      playbackType: "round-robin",
      createdAt: new Date(), // Temporary, won't be saved like this
      updatedAt: new Date(), // Temporary
      // name and keyBinding will be handled by EditPadModalContent defaults/state
    };

    openModal({
      title: "Edit Pad", // Updated title
      content: (
        // Use the new modal content component
        <EditPadModalContent
          ref={editModalRef} // Assign the ref
          initialPadConfig={initialConfig}
          profileId={numericProfileId}
          pageIndex={currentPageIndex}
          padIndex={padIndex}
        />
      ),
      confirmText: "Save Changes", // Updated button text
      onConfirm: async () => {
        if (!editModalRef.current) {
          console.error("Edit modal ref not available on confirm.");
          closeModal(); // Close modal even on error
          return;
        }
        // Get the latest state from the modal content via the ref
        const updatedPadConfigData = editModalRef.current.getCurrentState();

        // Basic validation: Ensure at least one sound exists if name is not default? (Optional)
        // Or ensure name is set if sounds exist?

        try {
          // Upsert the configuration with the data from the modal state
          await upsertPadConfiguration(updatedPadConfigData);
          refreshPadConfigs(); // Refresh the grid display
          console.log(
            `Saved changes for pad ${padIndex}`,
            updatedPadConfigData,
          );

          const isEmergency = await isEmergencyPage(
            numericProfileId,
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
      },
    });
  };

  // Handles starting/stopping playback
  const handlePlaybackInteraction = (padConfig: PadConfiguration) => {
    if (activeProfileId === null) return;

    if (!hasInteracted.current) {
      resumeAudioContext();
      hasInteracted.current = true;
    }

    // Call triggerAudioForPad with the new signature, destructuring the config
    triggerAudioForPad({
      padIndex: padConfig.padIndex,
      audioFileIds: padConfig.audioFileIds,
      playbackType: padConfig.playbackType,
      activeProfileId: activeProfileId,
      currentPageIndex: currentPageIndex,
      name: padConfig.name,
    });
  };

  // Main click handler - delegates to other handlers
  const handlePadClick = (padIndex: number) => {
    const config = padConfigs.get(padIndex);

    if (isEditMode) {
      // If delete key is down AND the pad has *any* sounds, trigger remove/edit logic
      if (
        isDeleteKeyDown &&
        config?.audioFileIds &&
        config.audioFileIds.length > 0
      ) {
        handleRemoveInteraction(padIndex);
      } else {
        // Otherwise, always open the edit modal (even for empty pads)
        handleEditInteraction(config ?? null, padIndex);
      }
    } else {
      // Playback logic (only if configured)
      if (config && config.audioFileIds && config.audioFileIds.length > 0) {
        handlePlaybackInteraction(config);
      } else {
        console.log(`Pad index ${padIndex} has no config, cannot play.`);
      }
    }
  };

  // Handler for dropping audio files
  const handleDropAudio = useCallback(
    async (acceptedFiles: File[], padIndex: number) => {
      if (activeProfileId === null) {
        console.error("Cannot add audio, no active profile selected.");
        return;
      }
      if (acceptedFiles.length === 0) return;
      const file = acceptedFiles[0];
      if (!file.type.startsWith("audio/")) {
        console.error("Invalid file type dropped:", file.type);
        return;
      }

      try {
        const numericProfileId = activeProfileId;
        if (numericProfileId === null)
          throw new Error("Invalid Profile ID for drop");

        const audioFileId = await addAudioFile({
          blob: file,
          name: file.name,
          type: file.type,
        });
        const newPadConfig: Omit<
          PadConfiguration,
          "id" | "createdAt" | "updatedAt"
        > = {
          profileId: numericProfileId,
          pageIndex: currentPageIndex,
          padIndex: padIndex,
          audioFileIds: [audioFileId], // Use the new field as an array
          playbackType: "round-robin", // Default playback type for single drop
          name: file.name.replace(/\.[^/.]+$/, ""), // Set default name
          // keyBinding remains undefined initially
        };
        await upsertPadConfiguration(newPadConfig);
        refreshPadConfigs();

        const isEmergency = await isEmergencyPage(
          numericProfileId,
          currentPageIndex,
        );
        if (isEmergency) {
          incrementEmergencySoundsVersion();
        }
        await loadAndDecodeAudio(audioFileId);
      } catch (error) {
        console.error(
          `Error processing dropped file for pad index ${padIndex}:`,
          error,
        );
      }
    },
    [
      activeProfileId,
      currentPageIndex,
      incrementEmergencySoundsVersion,
      refreshPadConfigs,
    ],
  );

  // --- Special Pad Handlers ---
  const handleStopAllClick = useCallback(() => {
    stopAllAudio();
  }, []);
  const handleFadeOutAllClick = useCallback(() => {
    fadeOutAllAudio();
  }, []);

  // --- Render Logic ---
  const padElements = Array.from({ length: TOTAL_PADS }, (_, i) => {
    const padIndex = i;
    const config = padConfigs.get(padIndex);
    const padId = `pad-${activeProfileId ?? "none"}-${currentPageIndex}-${padIndex}`;
    const currentPlaybackState = activePlayback.get(padId);
    const isPlaying = !!currentPlaybackState;
    const isFading = currentPlaybackState?.isFading ?? false;
    const progress = currentPlaybackState?.progress ?? 0;
    const remainingTime = currentPlaybackState?.remainingTime;

    // --- Special Pad Logic (Using defined config) ---
    if (padIndex === SPECIAL_PAD_CONFIG.STOP_ALL.index) {
      return (
        <Pad
          key={padId}
          id={padId}
          padIndex={padIndex}
          profileId={activeProfileId}
          pageIndex={currentPageIndex}
          keyBinding={SPECIAL_PAD_CONFIG.STOP_ALL.keyBinding}
          name={SPECIAL_PAD_CONFIG.STOP_ALL.label}
          isConfigured={true} // Special pads are always "configured"
          soundCount={2} // Treat special pads as having multiple sounds to disable drop logic.
          isPlaying={false}
          isEditMode={isEditMode}
          onClick={handleStopAllClick}
          onShiftClick={() => {}} // No edit action
          onDropAudio={async () => {}} // No drop action
          onRemoveSound={undefined} // Cannot remove
        />
      );
    }
    if (padIndex === SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index) {
      return (
        <Pad
          key={padId}
          id={padId}
          padIndex={padIndex}
          profileId={activeProfileId}
          pageIndex={currentPageIndex}
          keyBinding={SPECIAL_PAD_CONFIG.FADE_OUT_ALL.keyBinding}
          name={SPECIAL_PAD_CONFIG.FADE_OUT_ALL.label}
          isConfigured={true} // Special pads are always "configured"
          soundCount={2} // Treat special pads as having multiple sounds to disable drop logic.
          isPlaying={false}
          isEditMode={isEditMode}
          onClick={handleFadeOutAllClick}
          onShiftClick={() => {}} // No edit action
          onDropAudio={async () => {}} // No drop action
          onRemoveSound={undefined} // Cannot remove
        />
      );
    }

    // --- Regular Pad Logic ---
    return (
      <Pad
        key={padId}
        id={padId}
        padIndex={padIndex}
        profileId={activeProfileId}
        pageIndex={currentPageIndex}
        keyBinding={config?.keyBinding}
        name={config?.name}
        // Check if audioFileIds exists and has length > 0
        isConfigured={
          !!(config?.audioFileIds && config.audioFileIds.length > 0)
        }
        soundCount={config?.audioFileIds?.length ?? 0} // Pass the actual sound count
        isPlaying={isPlaying}
        isFading={isFading}
        playProgress={progress}
        remainingTime={remainingTime}
        isEditMode={isEditMode}
        onClick={() => handlePadClick(padIndex)}
        onShiftClick={() => handlePadClick(padIndex)} // Shift click now also goes through handlePadClick
        onDropAudio={handleDropAudio}
        onRemoveSound={
          // Enable remove interaction if sounds exist
          config?.audioFileIds && config.audioFileIds.length > 0
            ? () => handleRemoveInteraction(padIndex)
            : undefined
        }
      />
    );
  });

  return (
    <div
      className="grid gap-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg shadow"
      style={{
        gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
      }}
    >
      {padElements}
    </div>
  );
};

export default PadGrid;
