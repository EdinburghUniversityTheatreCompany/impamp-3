import React, { useMemo, useState } from "react";
import { useDropzone, Accept } from "react-dropzone";
import clsx from "clsx";
import { getDefaultKeyForPadIndex } from "@/lib/keyboardUtils";
import PadProgressBar from "./PadProgressBar"; // Import the new component

interface PadProps {
  id: string; // Unique identifier for the pad element itself
  padIndex: number; // Index of the pad within its page/grid
  profileId: number | null; // ID of the current profile
  pageIndex: number; // Index of the current page
  keyBinding?: string;
  name?: string;
  isConfigured: boolean; // Still useful for basic styling/remove button
  soundCount: number; // Number of sounds configured for this pad
  isPlaying: boolean;
  isFading?: boolean; // Prop to indicate if the sound is fading out
  playProgress?: number; // Prop to show play progress (0 to 1)
  remainingTime?: number; // Prop for remaining time in seconds
  isEditMode: boolean; // Whether we're in edit mode (shift key is pressed)
  isDeleteMoveMode?: boolean; // Whether we're in delete/move mode
  isSpecialPad?: boolean; // Whether this is a special control pad (Stop All, Fade Out All) that can't be deleted or moved
  onClick: () => void;
  onShiftClick: () => void; // Callback for shift+click (for renaming)
  onDropAudio: (acceptedFiles: File[], padIndex: number) => Promise<void>; // Callback for drop
  onRemoveSound?: () => void; // New callback for removing sound from pad
  onSwapWith?: (fromIndex: number, toIndex: number) => void; // Callback for pad swapping
}

const Pad: React.FC<PadProps> = ({
  id,
  padIndex,
  keyBinding,
  name = "Empty Pad",
  isConfigured,
  isPlaying,
  isFading = false, // Default to false
  playProgress = 0,
  remainingTime,
  isEditMode,
  isDeleteMoveMode = false,
  isSpecialPad = false, // Default to false
  onClick,
  onShiftClick,
  onDropAudio,
  onRemoveSound,
  onSwapWith,
  soundCount, // Destructure the new prop
  // profileId and pageIndex are passed but not used directly in this component
}) => {
  // State for drag and drop operations
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

  // Calculate remaining seconds (rounded) if playing and time is available
  const remainingSeconds =
    isPlaying && typeof remainingTime === "number"
      ? Math.max(0, Math.round(remainingTime))
      : null;

  // Get the default key binding for this pad position if no custom binding is set
  const displayKeyBinding = useMemo(() => {
    // Pass cols to the key mapping function
    return keyBinding || getDefaultKeyForPadIndex(padIndex);
  }, [keyBinding, padIndex]);

  // Updated drop handler: Check sound count before calling parent handler
  const handleAudioDrop = React.useCallback(
    (acceptedFiles: File[]) => {
      // Prevent drop if more than one sound is already configured
      if (soundCount > 1) {
        console.log(
          `Drop prevented on pad ${padIndex}: Already has ${soundCount} sounds.`,
        );
        // Optionally show a user notification here
        return;
      }
      // Proceed with drop if 0 or 1 sound exists
      if (acceptedFiles.length > 0) {
        onDropAudio(acceptedFiles, padIndex);
      }
    },
    [onDropAudio, padIndex, soundCount], // Add soundCount to dependencies
  );

  // Drag and drop handlers for delete/move mode
  const handleDragStart = (e: React.DragEvent) => {
    if (!isDeleteMoveMode) return;

    console.log(`Started dragging pad ${padIndex}`);
    setIsDragging(true);
    e.dataTransfer.setData("text/plain", padIndex.toString());
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isDeleteMoveMode) return;

    e.preventDefault();
    setIsOver(true);
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragLeave = () => {
    setIsOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isDeleteMoveMode || !onSwapWith) return;

    e.preventDefault();
    setIsOver(false);

    const fromPadIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (fromPadIndex !== padIndex && !isNaN(fromPadIndex)) {
      console.log(`Swapping pad ${fromPadIndex} with pad ${padIndex}`);
      onSwapWith(fromPadIndex, padIndex);
    }
  };

  // Disable dropzone if soundCount > 1
  const isDropDisabled = soundCount > 1;

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    isDragAccept,
    isDragReject,
  } = useDropzone({
    onDrop: handleAudioDrop,
    accept: { "audio/*": [] } as Accept, // Accept all audio types
    noClick: true, // Prevent opening file dialog on click (we handle click for playback)
    noKeyboard: true, // Prevent opening file dialog with keyboard
    multiple: false, // Accept only one file at a time
    disabled: isDropDisabled || isDeleteMoveMode, // Disable dropzone based on sound count or in delete/move mode
  });

  // --- Styling with clsx ---
  const padClasses = useMemo(
    () =>
      clsx(
        "relative",
        "aspect-square",
        "border",
        "rounded-md",
        "flex",
        "flex-col",
        "items-center",
        "justify-center",
        "p-2",
        "text-center",
        "cursor-pointer",
        "transition-all",
        "duration-150",
        "overflow-hidden",
        {
          // Base background/hover based on configuration
          "bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600":
            isConfigured,
          "bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700":
            !isConfigured,
        },
        {
          // Text color based on configuration
          "text-gray-800 dark:text-gray-200": isConfigured,
          "text-gray-500 dark:text-gray-400": !isConfigured,
        },
        {
          // Edit mode border
          "border-2 border-amber-500 hover:border-amber-600 dark:border-amber-400":
            isEditMode,
        },
        {
          // Delete/Move mode styling
          "border-2 border-red-500 hover:border-red-600 dark:border-red-400":
            isDeleteMoveMode && !isDragging && !isOver,
          "border-2 border-red-500 border-dashed bg-red-100 dark:bg-red-900/20":
            isDeleteMoveMode && (isDragging || isOver),
          "opacity-50": isDeleteMoveMode && isDragging,
          "ring-2 ring-red-500": isDeleteMoveMode && isOver,
        },
        {
          // Playing/Fading ring indicator
          "ring-2 ring-offset-2 dark:ring-offset-gray-900 ring-yellow-500 animate-pulse":
            isFading,
          "ring-2 ring-offset-2 dark:ring-offset-gray-900 ring-blue-500":
            isPlaying && !isFading,
        },
        {
          // Dropzone active state border (only if not disabled)
          "border-blue-500 border-dashed":
            isDragActive && !isDropDisabled && !isDeleteMoveMode,
          "border-gray-300 dark:border-gray-600":
            !isDragActive &&
            !isEditMode &&
            !isDeleteMoveMode &&
            !isDropDisabled, // Default border
          // Edit mode border takes precedence if dropzone is disabled
          "border-2 border-amber-500 hover:border-amber-600 dark:border-amber-400":
            isEditMode && isDropDisabled,
        },
        {
          // Dropzone accept/reject background/border
          "bg-green-100 dark:bg-green-900 border-green-500":
            isDragAccept && !isDeleteMoveMode,
          "bg-red-100 dark:bg-red-900 border-red-500":
            isDragReject && !isDeleteMoveMode,
        },
      ),
    [
      isConfigured,
      isEditMode,
      isDeleteMoveMode,
      isPlaying,
      isFading,
      isDragActive,
      isDragAccept,
      isDragReject,
      isDropDisabled,
      isDragging,
      isOver,
    ],
  );

  return (
    // Spread dropzone props onto the root div
    <div
      {...getRootProps()}
      id={id} // Use the passed unique ID
      className={padClasses} // Use clsx generated classes
      // Make clickable area separate from dropzone root if needed, but here it's combined
      // The single onClick handler below manages both playback and prevents dropzone default click
      onClick={(e) => {
        // Prevent dropzone's default click behavior if necessary, though noClick should handle it
        e.stopPropagation();

        // In Delete/Move mode, clicking deletes the pad (but not for special pads)
        if (
          isDeleteMoveMode &&
          isConfigured &&
          onRemoveSound &&
          !isSpecialPad
        ) {
          onRemoveSound();
        }
        // In Edit mode, clicking opens the edit modal
        else if (isEditMode) {
          onShiftClick();
        }
        // In normal mode, clicking plays the sound
        else {
          onClick();
        }
      }}
      draggable={isDeleteMoveMode && !isSpecialPad}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={0} // Make it focusable
      aria-label={`Sound pad ${padIndex + 1}${name !== "Empty Pad" ? `: ${name}` : ""}${displayKeyBinding ? `, key ${displayKeyBinding}` : ""}`}
    >
      {/* Input element required by react-dropzone - add data-testid */}
      <input {...getInputProps()} data-testid={`pad-drop-input-${padIndex}`} />

      {/* Pad Name Display - with better wrapping and edit mode indicator */}
      <span className="text-sm font-medium break-all w-full text-center z-10">
        {name}
      </span>

      {/* Key Binding Display at the bottom - show default key binding if no custom binding */}
      {displayKeyBinding && !isDeleteMoveMode && (
        <span className="absolute bottom-1 left-1/2 transform -translate-x-1/2 text-xs font-mono bg-gray-300 dark:bg-gray-600 px-1 rounded z-10">
          {/* Display 'ESC' or 'SPACE' nicely, otherwise show the key */}
          {displayKeyBinding === "Escape"
            ? "ESC"
            : displayKeyBinding === " "
              ? "SPACE"
              : displayKeyBinding}
        </span>
      )}

      {/* Use the extracted PadProgressBar component */}
      {(isPlaying || isFading) &&
        !isDeleteMoveMode && ( // Show progress bar if playing or fading
          <PadProgressBar
            progress={playProgress}
            remainingTime={remainingSeconds} // Pass the calculated rounded seconds
          />
        )}

      {/* Dropzone overlay message (only show if drop is not disabled and not in delete/move mode) */}
      {isDragActive && !isDropDisabled && !isDeleteMoveMode && (
        <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center z-20 rounded-md">
          <span className="text-white text-lg font-semibold">
            {isDragAccept && "Drop to replace sound"}
            {isDragReject && "Invalid file type"}
            {!isDragAccept && !isDragReject && "Drop audio file"}
          </span>
        </div>
      )}

      {/* Message indicating drop is disabled */}
      {isDragActive && isDropDisabled && !isDeleteMoveMode && (
        <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-20 rounded-md">
          <span className="text-white text-center text-sm font-semibold px-2">
            Cannot drop here. Edit pad to manage multiple sounds.
          </span>
        </div>
      )}

      {/* Delete/move mode - Show deletion icon or drag handle (except for special pads) */}
      {isDeleteMoveMode && isConfigured && !isSpecialPad && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <span className="text-red-500 dark:text-red-400 text-2xl">
            {isDragging ? "•••" : "×"}
          </span>
        </div>
      )}
    </div>
  );
};

export default Pad;
