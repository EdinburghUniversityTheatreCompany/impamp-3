"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Pad from "./Pad";
import { useProfileStore } from "@/store/profileStore";
import { useUIStore } from "@/store/uiStore";
import PromptModalContent from "./modals/PromptModalContent";
import ConfirmModalContent from "./modals/ConfirmModalContent";
import { usePadConfigurations } from "@/hooks/usePadConfigurations";
import {
  PadConfiguration,
  addAudioFile,
  upsertPadConfiguration,
  isEmergencyPage,
} from "@/lib/db";
import {
  loadAndDecodeAudio,
  playAudio,
  stopAudio,
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
    const audioIdsToLoad: number[] = [];
    padConfigs.forEach((config) => {
      if (config.audioFileId) audioIdsToLoad.push(config.audioFileId);
    });
    if (audioIdsToLoad.length > 0) {
      console.log(
        `[PadGrid Preload] Triggering preload for ${audioIdsToLoad.length} audio IDs on page ${currentPageIndex}`,
      );
      preloadAudioForPage(audioIdsToLoad);
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

  // Handles removing sound via modal confirmation
  const handleRemoveInteraction = (padIndex: number) => {
    const config = padConfigs.get(padIndex);
    if (!config || !config.audioFileId || activeProfileId === null) return;
    const soundName = config.name || `Pad ${padIndex + 1}`;

    openModal({
      title: "Remove Sound",
      content: (
        <ConfirmModalContent
          message={`Remove sound "${soundName}" from this pad?`}
        />
      ),
      confirmText: "Remove",
      onConfirm: async () => {
        try {
          const numericProfileId = activeProfileId;
          if (numericProfileId === null)
            throw new Error("Invalid Profile ID for removal");

          await upsertPadConfiguration({
            profileId: numericProfileId,
            pageIndex: currentPageIndex,
            padIndex: padIndex,
            name: undefined,
            audioFileId: undefined,
            keyBinding: config.keyBinding,
          });
          refreshPadConfigs();
          console.log(`Removed sound from pad ${padIndex}`);

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

  // Handles opening the edit/rename modal
  const handleEditInteraction = (
    padConfig: PadConfiguration | null,
    padIndex: number,
  ) => {
    if (activeProfileId === null) {
      console.error("Cannot edit pad, no active profile.");
      alert("Cannot edit pad, no active profile selected.");
      return;
    }
    const currentName = padConfig?.name || `Pad ${padIndex + 1}`;
    let modalDataValue = currentName;

    openModal({
      title: "Rename Pad", // Will change later
      content: (
        <PromptModalContent // Will change later
          label="Enter new name for pad:"
          initialValue={currentName}
          onValueChange={(value) => {
            modalDataValue = value;
          }}
        />
      ),
      confirmText: "Rename", // Will change later
      onConfirm: async () => {
        const newName = modalDataValue;
        const finalName = newName.trim() || currentName;

        if (finalName !== currentName || !padConfig?.name) {
          try {
            const numericProfileId = activeProfileId;
            if (numericProfileId === null)
              throw new Error("Invalid Profile ID for rename");

            await upsertPadConfiguration({
              profileId: numericProfileId,
              pageIndex: currentPageIndex,
              padIndex: padIndex,
              name: finalName,
              audioFileId: padConfig?.audioFileId,
              keyBinding: padConfig?.keyBinding,
            });
            refreshPadConfigs();
            console.log(`Renamed pad ${padIndex} to "${finalName}"`);

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
            console.error(`Failed to rename pad ${padIndex}:`, error);
            alert(`Failed to rename pad ${padIndex}. Please try again.`);
          } finally {
            closeModal();
          }
        } else {
          closeModal();
        }
      },
    });
  };

  // Handles starting/stopping playback
  const handlePlaybackInteraction = (
    padConfig: PadConfiguration,
    padIndex: number,
  ) => {
    if (activeProfileId === null) return;

    if (!hasInteracted.current) {
      resumeAudioContext();
      hasInteracted.current = true;
    }

    const playbackKey = `pad-${activeProfileId}-${currentPageIndex}-${padIndex}`;

    if (activePlayback.has(playbackKey)) {
      stopAudio(playbackKey);
      console.log(
        `[PadGrid] Stopped playback for pad index: ${padIndex} (key: ${playbackKey})`,
      );
    } else if (padConfig.audioFileId) {
      // Check if audioFileId exists
      console.log(
        `Attempting to play audio for pad index: ${padIndex}, file ID: ${padConfig.audioFileId}`,
      );
      (async () => {
        try {
          // Ensure audioFileId is a number before calling loadAndDecodeAudio
          if (typeof padConfig.audioFileId === "number") {
            const buffer = await loadAndDecodeAudio(padConfig.audioFileId);
            if (buffer) {
              console.log(
                `[PadGrid] Buffer obtained for file ID: ${padConfig.audioFileId}. Playing...`,
              );
              playAudio(buffer, playbackKey, {
                name: padConfig.name || `Pad ${padIndex + 1}`,
                padInfo: {
                  profileId: activeProfileId,
                  pageIndex: currentPageIndex,
                  padIndex: padIndex,
                },
              });
            } else {
              console.error(
                `[PadGrid] Failed to load or decode audio for file ID: ${padConfig.audioFileId}`,
              );
            }
          } else {
            console.error(
              `[PadGrid] Invalid audioFileId for pad index ${padIndex}: ${padConfig.audioFileId}`,
            );
          }
        } catch (error) {
          console.error(
            `Error during playback for pad index ${padIndex}:`,
            error,
          );
        }
      })();
    } else {
      console.log(`Pad index ${padIndex} has no audio configured.`);
    }
  };

  // Main click handler - delegates to other handlers
  const handlePadClick = (padIndex: number) => {
    const config = padConfigs.get(padIndex);

    if (isEditMode) {
      if (isDeleteKeyDown && config?.audioFileId) {
        handleRemoveInteraction(padIndex);
      } else {
        handleEditInteraction(config ?? null, padIndex);
      }
    } else {
      if (config) {
        handlePlaybackInteraction(config, padIndex);
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
          audioFileId: audioFileId,
          name: file.name.replace(/\.[^/.]+$/, ""),
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
          isConfigured={true}
          isPlaying={false}
          isEditMode={isEditMode}
          onClick={handleStopAllClick}
          onShiftClick={() => {}}
          onDropAudio={async () => {}}
          onRemoveSound={undefined}
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
          isConfigured={true}
          isPlaying={false}
          isEditMode={isEditMode}
          onClick={handleFadeOutAllClick}
          onShiftClick={() => {}}
          onDropAudio={async () => {}}
          onRemoveSound={undefined}
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
        isConfigured={!!config?.audioFileId}
        isPlaying={isPlaying}
        isFading={isFading}
        playProgress={progress}
        remainingTime={remainingTime}
        isEditMode={isEditMode}
        onClick={() => handlePadClick(padIndex)}
        onShiftClick={() => handlePadClick(padIndex)} // Shift click now also goes through handlePadClick
        onDropAudio={handleDropAudio}
        onRemoveSound={
          config?.audioFileId
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
