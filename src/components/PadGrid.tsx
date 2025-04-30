"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Pad from "./Pad";
import { useProfileStore } from "@/store/profileStore";
import { useUIStore } from "@/store/uiStore";
import ConfirmModalContent from "./modals/ConfirmModalContent";
import EditPadModalContent, {
  EditPadModalContentRef,
} from "./modals/EditPadModalContent";
import BulkImportModalContent from "./modals/BulkImportModalContent";
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
  const isDeleteMoveMode = useProfileStore((state) => state.isDeleteMoveMode);
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

  // Handler for swapping pads in delete/move mode - COMPLETELY REWRITTEN TO FIX THE CONSTRAINT ERROR
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
        fromIndex === SPECIAL_PAD_CONFIG.STOP_ALL.index ||
        fromIndex === SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index ||
        toIndex === SPECIAL_PAD_CONFIG.STOP_ALL.index ||
        toIndex === SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index
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
      incrementEmergencySoundsVersion,
    ],
  );

  // Main click handler - delegates to other handlers
  const handlePadClick = (padIndex: number) => {
    const config = padConfigs.get(padIndex);

    // Different behavior based on mode
    if (isDeleteMoveMode) {
      // In delete mode, clicking directly removes the sound
      if (config?.audioFileIds && config.audioFileIds.length > 0) {
        handleRemoveInteraction(padIndex);
      }
    } else if (isEditMode) {
      // In edit mode
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
      // Normal mode - playback logic
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
          isDeleteMoveMode={isDeleteMoveMode} // Pass delete/move mode state
          isSpecialPad={true} // Mark as special pad - can't be deleted or moved
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
          isDeleteMoveMode={isDeleteMoveMode} // Pass delete/move mode state
          isSpecialPad={true} // Mark as special pad - can't be deleted or moved
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
        isDeleteMoveMode={isDeleteMoveMode}
        onClick={() => handlePadClick(padIndex)}
        onShiftClick={() => handlePadClick(padIndex)} // Shift click now also goes through handlePadClick
        onDropAudio={handleDropAudio}
        onRemoveSound={
          // Enable remove interaction if sounds exist
          config?.audioFileIds && config.audioFileIds.length > 0
            ? () => handleRemoveInteraction(padIndex)
            : undefined
        }
        onSwapWith={handleSwapPads}
      />
    );
  });

  // Open the bulk import modal
  const handleOpenBulkImport = useCallback(() => {
    if (activeProfileId === null) {
      console.error("Cannot bulk import, no active profile selected.");
      return;
    }

    // Create a simplified map of existing configurations to pass to the modal
    const existingConfigMap = new Map<
      number,
      { name?: string; soundCount: number }
    >();
    padConfigs.forEach((config, index) => {
      existingConfigMap.set(index, {
        name: config.name,
        soundCount: config.audioFileIds?.length || 0,
      });
    });

    openModal({
      title: "Bulk Import Audio Files",
      content: (
        <BulkImportModalContent
          profileId={activeProfileId}
          pageIndex={currentPageIndex}
          existingPadConfigs={existingConfigMap}
          onAssignmentComplete={() => {
            closeModal();
            refreshPadConfigs();
            // Check if we're on an emergency page and refresh if needed
            isEmergencyPage(activeProfileId, currentPageIndex).then(
              (isEmergency) => {
                if (isEmergency) {
                  incrementEmergencySoundsVersion();
                  console.log("Emergency page updated after bulk import");
                }
              },
            );
          }}
        />
      ),
      confirmText: "",
      showConfirmButton: false,
      size: "full",
    });
  }, [
    activeProfileId,
    currentPageIndex,
    padConfigs,
    openModal,
    closeModal,
    refreshPadConfigs,
    incrementEmergencySoundsVersion,
  ]);

  return (
    <div className="flex flex-col gap-4">
      {/* Show Bulk Import button only in delete/move mode */}
      {isDeleteMoveMode && activeProfileId !== null && (
        <div className="flex justify-end mb-2">
          <button
            onClick={handleOpenBulkImport}
            className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md flex items-center"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Bulk Import
          </button>
        </div>
      )}

      <div
        className="grid gap-2 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg shadow"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {padElements}
      </div>
    </div>
  );
};

export default PadGrid;
