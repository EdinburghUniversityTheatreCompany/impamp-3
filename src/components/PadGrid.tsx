"use client";

import React, { useRef, useMemo } from "react";
import Pad from "./Pad";
import { useProfileStore } from "@/store/profileStore";
import { useUIStore } from "@/store/uiStore";
import { usePadConfigurations } from "@/hooks/usePadConfigurations";
import { isEmergencyPage } from "@/lib/db";
import {
  stopAllAudio,
  fadeOutAllAudio,
  preloadCurrentPageIntelligent,
  preloadAllConfiguredFiles,
} from "@/lib/audio";
import { usePlaybackStore, useArmedTracks } from "@/store/playbackStore";
import { GRID_COLS, GRID_ROWS, TOTAL_PADS } from "@/lib/constants";
import { usePadInteractions, usePadSwap, usePadDrop } from "@/hooks/pad";
import type { EditPadModalContentRef } from "@/components/modals/EditPadModalContent";
import BulkImportModalContent from "./modals/BulkImportModalContent";
import { useEffect } from "react";

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

// Get array of special pad indices for checking
const SPECIAL_PAD_INDICES = [
  SPECIAL_PAD_CONFIG.STOP_ALL.index,
  SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index,
];

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

  // Refs
  const hasInteracted = useRef(false);
  const editModalRef = useRef<EditPadModalContentRef>(null);

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

  // Subscribe to the playback and armed tracks stores
  const activePlayback = usePlaybackStore((state) => state.activePlayback);
  const armedTracks = useArmedTracks();

  // Use custom hooks for pad functionality
  const {
    handleRemoveInteraction,
    handleEditInteraction,
    handlePlaybackInteraction,
    handleArmTrack,
  } = usePadInteractions({
    currentPageIndex,
    padConfigs,
    refreshPadConfigs,
    editModalRef: editModalRef as React.RefObject<EditPadModalContentRef>,
    hasInteracted,
  });

  const { handleSwapPads } = usePadSwap({
    currentPageIndex,
    padConfigs,
    refreshPadConfigs,
    specialPadIndices: SPECIAL_PAD_INDICES,
  });

  const { handleDropAudio, isDropAllowed } = usePadDrop(
    currentPageIndex,
    refreshPadConfigs,
  );

  // Log loading and error states
  useEffect(() => {
    if (isLoadingConfigs) {
      console.log("[PadGrid] Loading pad configurations...");
    }
    if (configError) {
      console.error("[PadGrid] Error loading pad configurations:", configError);
    }
  }, [isLoadingConfigs, configError]);

  // Intelligent preload audio files for current page and background loading
  useEffect(() => {
    if (activeProfileId === null || padConfigs.size === 0) return;

    const configsArray = Array.from(padConfigs.values());
    if (configsArray.length > 0) {
      // Immediate preload for current page with highest priority
      console.log(
        `[PadGrid Preload] Intelligent preload for page ${currentPageIndex}`,
      );
      preloadCurrentPageIntelligent(
        configsArray,
        activeProfileId,
        currentPageIndex,
      );

      // Background preload all configured files (lower priority)
      // This will intelligently prioritize recently played files
      preloadAllConfiguredFiles(configsArray, activeProfileId);
    }
  }, [padConfigs, activeProfileId, currentPageIndex]);

  // Delete key state tracking
  const [isDeleteKeyDown, setIsDeleteKeyDown] = React.useState(false);
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

  // Special pad handlers
  const handleStopAllClick = () => stopAllAudio();
  const handleFadeOutAllClick = () => fadeOutAllAudio();

  // Main click handler - delegates to appropriate handlers
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
        handleEditInteraction(padIndex);
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

  // Open the bulk import modal
  const handleOpenBulkImport = () => {
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
  };

  // Generate pad elements
  const padElements = useMemo(() => {
    return Array.from({ length: TOTAL_PADS }, (_, i) => {
      const padIndex = i;
      const config = padConfigs.get(padIndex);
      const padId = `pad-${activeProfileId ?? "none"}-${currentPageIndex}-${padIndex}`;
      const armedKey = `armed-${activeProfileId ?? "none"}-${currentPageIndex}-${padIndex}`;
      const currentPlaybackState = activePlayback.get(padId);
      const isPlaying = !!currentPlaybackState;
      const isFading = currentPlaybackState?.isFading ?? false;
      const progress = currentPlaybackState?.progress ?? 0;
      const remainingTime = currentPlaybackState?.remainingTime;
      const isArmed = armedTracks.has(armedKey);
      const soundCount = config?.audioFileIds?.length ?? 0;
      const isSpecialPad = SPECIAL_PAD_INDICES.includes(padIndex);

      // --- Special Pad Logic ---
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
            soundCount={2} // Treat special pads as having multiple sounds to disable drop logic
            isPlaying={false}
            isEditMode={isEditMode}
            isDeleteMoveMode={isDeleteMoveMode}
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
            soundCount={2} // Treat special pads as having multiple sounds to disable drop logic
            isPlaying={false}
            isEditMode={isEditMode}
            isDeleteMoveMode={isDeleteMoveMode}
            isSpecialPad={true} // Mark as special pad - can't be deleted or moved
            onClick={handleFadeOutAllClick}
            onShiftClick={() => {}} // No edit action
            onDropAudio={async () => {}} // No drop action
            onRemoveSound={undefined} // Cannot remove
          />
        );
      }

      // --- Regular Pad Logic ---
      const dropAllowed = isDropAllowed(padIndex, soundCount, isSpecialPad);

      return (
        <Pad
          key={padId}
          id={padId}
          padIndex={padIndex}
          profileId={activeProfileId}
          pageIndex={currentPageIndex}
          keyBinding={config?.keyBinding}
          name={config?.name}
          isConfigured={soundCount > 0}
          soundCount={soundCount}
          audioFileIds={config?.audioFileIds} // Add audio file IDs for hover preloading
          isPlaying={isPlaying}
          isFading={isFading}
          playProgress={progress}
          remainingTime={remainingTime}
          isEditMode={isEditMode}
          isDeleteMoveMode={isDeleteMoveMode}
          isArmed={isArmed}
          onClick={() => handlePadClick(padIndex)}
          onShiftClick={() => handlePadClick(padIndex)} // Shift click also goes through handlePadClick
          onCtrlClick={() => handleArmTrack(padIndex)} // Ctrl+Click arms the track
          onDropAudio={(files) => {
            if (dropAllowed) {
              return handleDropAudio(files, padIndex);
            }
            return Promise.resolve(); // Return empty promise when drop not allowed
          }}
          onRemoveSound={
            // Enable remove interaction if sounds exist
            soundCount > 0 ? () => handleRemoveInteraction(padIndex) : undefined
          }
          onSwapWith={handleSwapPads}
        />
      );
    });
  }, [
    padConfigs,
    activeProfileId,
    currentPageIndex,
    activePlayback,
    armedTracks,
    isEditMode,
    isDeleteMoveMode,
    handleRemoveInteraction,
    handleArmTrack,
    handleDropAudio,
    isDropAllowed,
    handleSwapPads,
    handlePadClick,
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
