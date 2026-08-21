"use client";

import React, { useRef, useMemo, useCallback } from "react";
import Pad from "./Pad";
import { useProfileStore } from "@/store/profileStore";
// useUIStore removed - now using useModal hook
import {
  actionablePadConfigs,
  usePadConfigurations,
} from "@/hooks/usePadConfigurations";
import {
  stopAllAudio,
  fadeOutAllAudio,
  preloadCurrentPageIntelligent,
} from "@/lib/audio";
import { useArmedTracks } from "@/store/playbackStore";
import {
  GRID_COLS,
  GRID_ROWS,
  SPECIAL_PAD_CONFIG,
  SPECIAL_PAD_INDICES,
  TOTAL_PADS,
} from "@/lib/constants";
import { usePadInteractions, usePadSwap, usePadDrop } from "@/hooks/pad";
import { useModal } from "@/hooks/modal/useModal";
import { ModalType } from "@/components/modals/modalRegistry";
import { usePadLoadingState } from "@/store/loadingStore";
import { PadConfiguration } from "@/lib/db";
import { useEffect } from "react";

// Stable no-op handlers for the special pads (no edit or drop actions)
const noopClick = () => {};
const noopDropAudio = async () => {};

interface PadWithLoadingProps {
  padId: string;
  padIndex: number;
  profileId: number | null;
  bankId: string;
  config: PadConfiguration | undefined;
  soundCount: number;
  isEditMode: boolean;
  isDeleteMoveMode: boolean;
  isArmed: boolean;
  dropAllowed: boolean;
  handlePadClick: (padIndex: number) => void;
  handleArmTrack: (padIndex: number) => void;
  handleDropAudio: (files: File[], padIndex: number) => Promise<void>;
  handleRemoveInteraction: (padIndex: number) => void;
  handleSwapPads: (fromIndex: number, toIndex: number) => void;
}

const PadWithLoading: React.FC<PadWithLoadingProps> = React.memo(
  ({
    padId,
    padIndex,
    profileId,
    bankId,
    config,
    soundCount,
    isEditMode,
    isDeleteMoveMode,
    isArmed,
    dropAllowed,
    handlePadClick,
    handleArmTrack,
    handleDropAudio,
    handleRemoveInteraction,
    handleSwapPads,
  }) => {
    // Get loading state from shared store using hook
    const loadingState = usePadLoadingState(profileId, bankId, padIndex);

    // Stable per-pad callbacks so the memoized Pad only re-renders when its own state changes
    const onClick = useCallback(
      () => handlePadClick(padIndex),
      [handlePadClick, padIndex],
    );
    const onArm = useCallback(
      () => handleArmTrack(padIndex),
      [handleArmTrack, padIndex],
    );
    const onDropAudio = useCallback(
      (files: File[]) => {
        if (dropAllowed) {
          return handleDropAudio(files, padIndex);
        }
        return Promise.resolve(); // Return empty promise when drop not allowed
      },
      [dropAllowed, handleDropAudio, padIndex],
    );
    const onRemoveSound = useCallback(
      () => handleRemoveInteraction(padIndex),
      [handleRemoveInteraction, padIndex],
    );

    return (
      <Pad
        key={padId}
        id={padId}
        padIndex={padIndex}
        profileId={profileId}
        bankId={bankId}
        keyBinding={config?.keyBinding}
        name={config?.name}
        soundCount={soundCount}
        audioFileIds={config?.audioFileIds} // Add audio file IDs for hover preloading
        isDisabled={config?.isDisabled ?? false}
        isEditMode={isEditMode}
        isDeleteMoveMode={isDeleteMoveMode}
        isArmed={isArmed}
        isLoading={loadingState !== null}
        loadingProgress={loadingState?.progress || 0}
        loadingStatus={loadingState?.status}
        loadingError={loadingState?.error}
        onClick={onClick}
        onShiftClick={onClick} // Shift click also goes through handlePadClick
        onArm={onArm} // Ctrl+Click, or Cmd+Click on a Mac, arms the track
        onDropAudio={onDropAudio}
        onRemoveSound={
          // Enable remove interaction if sounds exist
          soundCount > 0 ? onRemoveSound : undefined
        }
        onSwapWith={handleSwapPads}
      />
    );
  },
);

PadWithLoading.displayName = "PadWithLoading";

interface PadGridProps {
  bankId: string;
}

const PadGrid: React.FC<PadGridProps> = ({ bankId }) => {
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const isEditMode = useProfileStore((state) => state.isEditMode);
  const isDeleteMoveMode = useProfileStore((state) => state.isDeleteMoveMode);
  const { openLazyModal, closeModal } = useModal();

  // Refs
  const hasInteractedRef = useRef(false);

  // Use the hook to get pad configurations
  const {
    padConfigs,
    isLoading: isLoadingConfigs,
    error: configError,
  } = usePadConfigurations(
    activeProfileId !== null ? String(activeProfileId) : null,
    bankId,
  );

  // Subscribe to the armed tracks store (each Pad subscribes to its own playback slice)
  const armedTracks = useArmedTracks();

  // The pads these hooks may *act* on, which is not the same set as the pads
  // worth drawing — see `actionablePadConfigs`.
  //
  // `handlePadClick` below has its own early return and so was already safe,
  // but `handleArmTrack` is wired straight to `Pad`'s onArm and bypasses
  // it entirely. During the read window that armed the previous bank's cue
  // under the new bank's key, which then surfaced at F9 rather than
  // immediately — the worst way for it to surface. Swapping is here for the
  // same reason: it moves sounds between pad positions, and doing that from
  // the wrong bank's map rearranges a board nobody is looking at.
  const actionableConfigs = actionablePadConfigs(padConfigs, isLoadingConfigs);

  // Use custom hooks for pad functionality
  const {
    handleRemoveInteraction,
    handleEditInteraction,
    handlePlaybackInteraction,
    handleArmTrack,
  } = usePadInteractions({
    currentBankId: bankId,
    padConfigs: actionableConfigs,
    hasInteractedRef,
  });

  const { handleSwapPads } = usePadSwap({
    currentBankId: bankId,
    padConfigs: actionableConfigs,
    specialPadIndices: SPECIAL_PAD_INDICES,
  });

  const { handleDropAudio, isDropAllowed } = usePadDrop(bankId);

  useEffect(() => {
    if (configError) {
      console.error("[PadGrid] Error loading pad configurations:", configError);
    }
  }, [configError]);

  // Preload decoded buffers for the current page only. Pads on other pages
  // play instantly too — they stream directly from the stored blob until a
  // decoded buffer is available, so no whole-profile preload is needed.
  useEffect(() => {
    if (activeProfileId === null || padConfigs.size === 0) return;

    const configsArray = Array.from(padConfigs.values());
    if (configsArray.length > 0) {
      console.log(`[PadGrid Preload] Intelligent preload for bank ${bankId}`);
      preloadCurrentPageIntelligent(configsArray, activeProfileId, bankId);
    }
  }, [padConfigs, activeProfileId, bankId]);

  // Delete key state tracking.
  //
  // `keyup` is not guaranteed to arrive: alt-tab away with Delete held and the
  // browser gives the release to whatever has focus next, leaving this stuck
  // on. It is only consulted in edit mode, where a stuck `true` turns an
  // ordinary click on a pad into *removing its sound* — so returning to the
  // tab and clicking a pad deleted it.
  //
  // `useKeyboardListener` learned this for the Shift key and added exactly
  // these two guards; this listener predates that and never got them.
  const [isDeleteKeyDown, setIsDeleteKeyDown] = React.useState(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete") setIsDeleteKeyDown(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Delete") setIsDeleteKeyDown(false);
    };
    const release = () => setIsDeleteKeyDown(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") release();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Special pad handlers
  const handleStopAllClick = useCallback(() => stopAllAudio(), []);
  const handleFadeOutAllClick = useCallback(() => fadeOutAllAudio(), []);

  // Main click handler - delegates to appropriate handlers
  const handlePadClick = useCallback(
    (padIndex: number) => {
      // `usePadConfigurations` keeps the last successful result while the next
      // request is in flight, so between pressing a bank key and the read
      // resolving these are still the *previous* bank's pads — shown under the
      // new bank's number. Acting on them played the old bank's sound at the
      // new bank's position, and in edit mode edited or deleted it.
      //
      // Same rule as `actionablePadConfigs`, which is what the keyboard path
      // uses; an early return is the shape that fits here because an empty pad
      // is still a legitimate click target in edit mode. Change one, change
      // both — the keyboard went without this guard for a while and fired the
      // previous bank's sounds the whole time.
      if (isLoadingConfigs) return;

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
    },
    [
      padConfigs,
      isLoadingConfigs,
      isDeleteMoveMode,
      isEditMode,
      isDeleteKeyDown,
      handleRemoveInteraction,
      handleEditInteraction,
      handlePlaybackInteraction,
    ],
  );

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

    openLazyModal({
      title: "Bulk Import Audio Files",
      modalType: ModalType.BULK_IMPORT,
      modalProps: {
        profileId: activeProfileId,
        bankId,
        existingPadConfigs: existingConfigMap,
        // The importer announces its own writes, the way every other pad
        // write does — this callback used to carry the version bump for it,
        // which is how the two halves of that announcement came to live in
        // different files.
        onAssignmentComplete: closeModal,
      },
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
      const padId = `pad-${activeProfileId ?? "none"}-${bankId}-${padIndex}`;
      const armedKey = `armed-${activeProfileId ?? "none"}-${bankId}-${padIndex}`;
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
            bankId={bankId}
            keyBinding={SPECIAL_PAD_CONFIG.STOP_ALL.keyBinding}
            name={SPECIAL_PAD_CONFIG.STOP_ALL.label}
            // A special pad holds no sounds. It used to claim two, to switch
            // off drop handling that `isSpecialPad` switches off anyway, and
            // to claim `isConfigured` beside them — the pad now reads "filled"
            // from `isSpecialPad` itself.
            soundCount={0}
            isEditMode={isEditMode}
            isDeleteMoveMode={isDeleteMoveMode}
            isSpecialPad={true} // Mark as special pad - can't be deleted or moved
            onClick={handleStopAllClick}
            onShiftClick={noopClick} // No edit action
            onDropAudio={noopDropAudio} // No drop action
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
            bankId={bankId}
            keyBinding={SPECIAL_PAD_CONFIG.FADE_OUT_ALL.keyBinding}
            name={SPECIAL_PAD_CONFIG.FADE_OUT_ALL.label}
            // As above: no sounds, and `isSpecialPad` is what refuses drops.
            soundCount={0}
            isEditMode={isEditMode}
            isDeleteMoveMode={isDeleteMoveMode}
            isSpecialPad={true} // Mark as special pad - can't be deleted or moved
            onClick={handleFadeOutAllClick}
            onShiftClick={noopClick} // No edit action
            onDropAudio={noopDropAudio} // No drop action
            onRemoveSound={undefined} // Cannot remove
          />
        );
      }

      // --- Regular Pad Logic ---
      const dropAllowed = isDropAllowed(padIndex, soundCount, isSpecialPad);

      return (
        <PadWithLoading
          key={padId}
          padId={padId}
          padIndex={padIndex}
          profileId={activeProfileId}
          bankId={bankId}
          config={config}
          soundCount={soundCount}
          isEditMode={isEditMode}
          isDeleteMoveMode={isDeleteMoveMode}
          isArmed={isArmed}
          dropAllowed={dropAllowed}
          handlePadClick={handlePadClick}
          handleArmTrack={handleArmTrack}
          handleDropAudio={handleDropAudio}
          handleRemoveInteraction={handleRemoveInteraction}
          handleSwapPads={handleSwapPads}
        />
      );
    });
  }, [
    padConfigs,
    activeProfileId,
    bankId,
    armedTracks,
    isEditMode,
    isDeleteMoveMode,
    handleRemoveInteraction,
    handleArmTrack,
    handleDropAudio,
    isDropAllowed,
    handleSwapPads,
    handlePadClick,
    handleStopAllClick,
    handleFadeOutAllClick,
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
