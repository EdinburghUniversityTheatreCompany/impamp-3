import React, { useMemo, useState } from "react";
import { useDropzone, Accept } from "react-dropzone";
import { fromEvent } from "file-selector";
import { COMMON_MIME_TYPES } from "file-selector/mime";
import clsx from "clsx";
import { getDefaultKeyForPadIndex } from "@/lib/keyboardUtils";
import { hasArmModifier } from "@/lib/platform";
import { preloadOnHover, generatePlaybackKey } from "@/lib/audio";
import { usePadPlaybackState, usePadLayerCount } from "@/store/playbackStore";
import PadProgressBar from "./PadProgressBar"; // Import the new component

interface PadProps {
  id: string; // Unique identifier for the pad element itself
  padIndex: number; // Index of the pad within its page/grid
  profileId: number | null; // ID of the current profile
  bankId: string; // Identity of the current bank
  keyBinding?: string;
  name?: string;
  soundCount: number; // Number of sounds configured for this pad
  audioFileIds?: number[]; // Audio file IDs for intelligent preloading
  isDisabled?: boolean; // Whether the pad is disabled (configured, but refuses to play)
  isEditMode: boolean; // Whether we're in edit mode (shift key is pressed)
  isDeleteMoveMode?: boolean; // Whether we're in delete/move mode
  isSpecialPad?: boolean; // Whether this is a special control pad (Stop All, Fade Out All) that can't be deleted or moved
  isArmed?: boolean; // Whether this pad is currently armed
  isLoading?: boolean; // Whether audio is currently loading
  loadingProgress?: number; // Loading progress (0 to 1)
  loadingStatus?: "loading" | "decoding" | "ready" | "error"; // Loading state
  loadingError?: string; // Error message if loading failed
  onClick: () => void;
  onShiftClick: () => void; // Callback for shift+click (for renaming)
  onArm?: () => void; // Callback for the arm chord (Ctrl/Cmd + click or Enter)
  onDropAudio: (acceptedFiles: File[], padIndex: number) => Promise<void>; // Callback for drop
  onRemoveSound?: () => void; // New callback for removing sound from pad
  onSwapWith?: (fromIndex: number, toIndex: number) => void; // Callback for pad swapping
}

const Pad: React.FC<PadProps> = ({
  id,
  padIndex,
  keyBinding,
  name = "Empty Pad",
  isDisabled = false,
  isEditMode,
  isDeleteMoveMode = false,
  isSpecialPad = false, // Default to false
  isArmed = false, // Default to false
  isLoading = false,
  loadingProgress = 0,
  loadingStatus,
  loadingError,
  onClick,
  onShiftClick,
  onArm,
  onDropAudio,
  onRemoveSound,
  onSwapWith,
  soundCount, // Destructure the new prop
  audioFileIds, // Destructure for hover preloading
  profileId,
  bankId,
}) => {
  // State for drag and drop operations
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

  // Subscribe to this pad's own playback slice only (special pads never play)
  const playbackKey =
    profileId !== null && !isSpecialPad
      ? generatePlaybackKey(profileId, bankId, padIndex)
      : null;
  const playbackState = usePadPlaybackState(playbackKey);
  const layerCount = usePadLayerCount(playbackKey);
  const isPlaying = playbackState !== null;
  const isFading = playbackState?.isFading ?? false;
  const playProgress = playbackState?.progress ?? 0;

  // Calculate remaining seconds (rounded) if playing and time is available
  const remainingSeconds =
    playbackState && typeof playbackState.remainingTime === "number"
      ? Math.max(0, Math.round(playbackState.remainingTime))
      : null;

  // Whether the pad reads as filled rather than empty. Derived, because
  // `soundCount` already answers it: this arrived as its own `isConfigured`
  // prop as well, so a caller could tell the same component that a pad was
  // configured *and* that it held no sounds — which is exactly what the two
  // special pads did, passing `isConfigured={true}` beside a fabricated
  // `soundCount={2}` to switch off drop handling that `isSpecialPad` already
  // switches off. Only styling asks this question; every behavioural branch
  // below asks `soundCount` directly.
  const isConfigured = soundCount > 0 || isSpecialPad;

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

  // Hover handler for intelligent preloading
  const handleMouseEnter = React.useCallback(() => {
    // Only preload if pad is configured, enabled, and we have audio file IDs
    if (
      soundCount > 0 &&
      !isDisabled &&
      audioFileIds &&
      audioFileIds.length > 0 &&
      profileId !== null
    ) {
      preloadOnHover(audioFileIds, {
        profileId,
        bankId,
        padIndex,
      });
    }
  }, [soundCount, isDisabled, audioFileIds, profileId, bankId, padIndex]);

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

  // A pad holding more than one sound refuses drops — you pick which sound to
  // replace in the edit modal instead. The dropzone stays *active* so react-
  // dropzone still reports isDragActive and the "Cannot drop here" overlay
  // below can explain the refusal; handleAudioDrop is what actually rejects
  // the file. Disabling the dropzone here would suppress isDragActive and the
  // overlay would never render.
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
    // file-selector (via react-dropzone 18+) no longer bundles its full
    // extension->MIME table, so a File the browser left typeless — routine for
    // the less common audio containers — would fail the `audio/*` filter above
    // and the drop would be discarded silently. Pull the full table back in.
    getFilesFromEvent: (event) =>
      fromEvent(event, { mimeTypes: COMMON_MIME_TYPES }),
    noClick: true, // Prevent opening file dialog on click (we handle click for playback)
    noKeyboard: true, // Prevent opening file dialog with keyboard
    multiple: false, // Accept only one file at a time
    // Special pads (Stop All, Fade Out All) take no audio at all, and there is
    // no edit modal to send the user to, so they stay fully disabled.
    disabled: isSpecialPad || isDeleteMoveMode,
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
        "transition-all",
        "duration-150",
        "overflow-hidden",
        {
          // A disabled pad is inert in normal mode, but still editable in the
          // modes that act on the pad itself rather than on its sound.
          "cursor-not-allowed": isDisabled && !isEditMode && !isDeleteMoveMode,
          "cursor-pointer": !isDisabled || isEditMode || isDeleteMoveMode,
        },
        {
          // Dimmed so it reads as "off" at a glance, but not so far that the
          // name stops being readable — you still have to find it to re-enable.
          "opacity-60": isDisabled,
        },
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
          // The amber edit-mode border is applied unconditionally on
          // isEditMode above, which already covers the isDropDisabled case.
        },
        {
          // Dropzone accept/reject background/border. A pad that will refuse
          // the file must not turn green, so accept styling also requires the
          // drop to actually be allowed.
          "bg-green-100 dark:bg-green-900 border-green-500":
            isDragAccept && !isDropDisabled && !isDeleteMoveMode,
          "bg-red-100 dark:bg-red-900 border-red-500":
            (isDragReject || (isDragActive && isDropDisabled)) &&
            !isDeleteMoveMode,
        },
      ),
    [
      isConfigured,
      isDisabled,
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

  const rootProps = getRootProps();

  /**
   * The pad's one activation path, shared by the pointer and the keyboard so
   * the two cannot drift into meaning different things.
   *
   * `withArmModifier` is the arm chord: Ctrl (or Cmd on a Mac) held with a
   * click, with Enter, or with Space. See `hasArmModifier` for why Ctrl alone
   * is not enough.
   */
  const activate = React.useCallback(
    (withArmModifier: boolean) => {
      // The arm chord queues the track instead of playing it
      if (withArmModifier && onArm && soundCount > 0) {
        onArm();
      }
      // In Delete/Move mode, activating deletes the pad (but not special pads)
      else if (
        isDeleteMoveMode &&
        soundCount > 0 &&
        onRemoveSound &&
        !isSpecialPad
      ) {
        onRemoveSound();
      }
      // In Edit mode, activating opens the edit modal
      else if (isEditMode) {
        onShiftClick();
      }
      // In normal mode, activating plays the sound
      else {
        onClick();
      }
    },
    [
      onArm,
      soundCount,
      isDeleteMoveMode,
      onRemoveSound,
      isSpecialPad,
      isEditMode,
      onShiftClick,
      onClick,
    ],
  );

  return (
    // Spread dropzone props onto the root div
    <div
      {...rootProps}
      id={id} // Use the passed unique ID
      className={padClasses} // Use clsx generated classes
      onMouseEnter={handleMouseEnter} // Add hover preloading
      // The single onClick handler below manages both playback and prevents dropzone default click
      onClick={(e) => {
        // Prevent dropzone's default click behavior if necessary, though noClick should handle it
        e.stopPropagation();
        activate(hasArmModifier(e));

        // A pointer click must not park focus on the pad.
        //
        // Enter and Space are global transport controls in this app — Enter
        // plays the emergency bank, Space is Fade Out All — and they have to
        // mean that at every moment of a show. Leaving focus behind would make
        // both depend on whichever pad the operator last touched, so reaching
        // for the emergency sound after firing a cue would retrigger the cue.
        //
        // This is safe precisely because a div is not a <button>: pressing
        // Enter on one does not synthesise a click, so onKeyDown below is the
        // only keyboard route in and this line never runs for a keyboard user.
        e.currentTarget.blur();
      }}
      // ARIA requires a role="button" element to activate on Enter and Space.
      // This one announced itself as a button and did neither, so a screen
      // reader user heard "Sound pad 3: Applause, button" and got the emergency
      // bank when they pressed Enter.
      //
      // preventDefault and stopPropagation are both load-bearing: the global
      // listener sits on `window` in the bubble phase, so stopping propagation
      // here is what keeps a focused pad's Enter from *also* firing the
      // emergency sound. The order matters too — a held key must be swallowed
      // before it is ignored, or every auto-repeat would fall through to the
      // global handler.
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // Holding a pad key must not retrigger it
        activate(hasArmModifier(e));
      }}
      draggable={isDeleteMoveMode && !isSpecialPad}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={(e) => {
        rootProps.onDragOver?.(e);
        handleDragOver(e);
      }}
      onDragLeave={(e) => {
        rootProps.onDragLeave?.(e);
        handleDragLeave();
      }}
      onDrop={(e) => {
        rootProps.onDrop?.(e);
        handleDrop(e);
      }}
      role="button"
      // Focusable, but out of the Tab ring — a deliberate deviation from the
      // usual advice, and the narrower half of what used to be an app-wide Tab
      // suppression in `useKeyboardListener`.
      //
      // Every pad prints its own hotkey and the aria-label repeats it (", key
      // q"), which is a better interaction than tabbing past 63 siblings. It is
      // also the safe one: this element claims Enter and Space for itself in
      // `onKeyDown` above, so focus landing here mid-show is exactly what would
      // turn the emergency bank and Fade Out All into "replay whichever pad Tab
      // stopped on". `-1` keeps that impossible while leaving the header, the
      // bank tabs and the profile selector reachable, which a blanket Tab
      // suppression could not.
      //
      // `-1` and not "no tabIndex at all": the tidier-looking answer would make
      // the pads unreachable by assistive tech even when focus is moved
      // programmatically, and would leave onKeyDown above dead code.
      tabIndex={-1}
      // Only inert in the modes where the click would have played the pad. In
      // edit / delete-move mode the pad is still an actionable target — that is
      // how it gets re-enabled — so it must not report itself as disabled.
      //
      // Keep this AFTER the {...rootProps} spread: since react-dropzone 17 it
      // stamps its own `aria-disabled` on the root whenever the dropzone is
      // disabled — which here means every special pad, and every pad while
      // delete/move mode is on, all of them still clickable. This line is what
      // overrides that. Drop it and those pads report themselves disabled to
      // assistive tech, and become unclickable to anything honouring the
      // attribute (Playwright included).
      aria-disabled={isDisabled && !isEditMode && !isDeleteMoveMode}
      aria-label={`Sound pad ${padIndex + 1}${name !== "Empty Pad" ? `: ${name}` : ""}${displayKeyBinding ? `, key ${displayKeyBinding}` : ""}${isDisabled ? ", disabled" : ""}`}
      title={isDisabled ? `${name} (disabled)` : undefined}
    >
      {/* Input element required by react-dropzone - add data-testid */}
      <input {...getInputProps()} data-testid={`pad-drop-input-${padIndex}`} />

      {/* Disabled badge - makes an "off" pad unmistakable mid-show */}
      {isDisabled && !isDeleteMoveMode && (
        <span
          className="absolute top-1 left-1 text-[10px] font-bold uppercase tracking-wide bg-gray-600 text-white px-1 rounded z-10 dark:bg-gray-500"
          data-testid="pad-disabled-indicator"
        >
          Off
        </span>
      )}

      {/* Pad Name Display - with better wrapping and edit mode indicator */}
      <span
        className={clsx(
          "text-sm font-medium break-all w-full text-center z-10",
          isDisabled && "line-through",
        )}
      >
        {name}
        {isArmed && <span className="ml-1 text-amber-500">★</span>}
      </span>

      {/* Layer count, shown only when a pad stacks. The ring and the remaining
          time already follow the newest layer; this says how many there are. */}
      {layerCount > 1 && (
        <span
          className="absolute top-1 right-1 z-10 rounded bg-blue-600 px-1 text-[10px] font-bold text-white"
          data-testid="pad-layer-count"
        >
          x{layerCount}
        </span>
      )}

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

      {/* Loading indicator for instant response */}
      {isLoading && !isDeleteMoveMode && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-15 rounded-md">
          <div className="text-center">
            {/* Spinner */}
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-white border-t-transparent mx-auto mb-1"></div>

            {/* Loading status text */}
            <div className="text-white text-xs font-medium">
              {loadingStatus === "loading" && "Loading..."}
              {loadingStatus === "decoding" && "Decoding..."}
              {loadingStatus === "error" && "Error"}
              {!loadingStatus && "Loading..."}
            </div>

            {/* Progress bar for loading */}
            {loadingProgress > 0 && (
              <div className="w-16 h-1 bg-gray-600 rounded-full mt-1 mx-auto overflow-hidden">
                <div
                  className="h-full bg-white transition-all duration-200"
                  style={{ width: `${Math.round(loadingProgress * 100)}%` }}
                />
              </div>
            )}

            {/* Error message */}
            {loadingError && (
              <div className="text-red-300 text-xs mt-1 max-w-20 truncate">
                {loadingError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dropzone overlay message (only show if drop is not disabled and not in delete/move mode) */}
      {isDragActive && !isDropDisabled && !isDeleteMoveMode && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-20 rounded-md">
          <span className="text-white text-lg font-semibold">
            {isDragAccept && "Drop to replace sound"}
            {isDragReject && "Invalid file type"}
            {!isDragAccept && !isDragReject && "Drop audio file"}
          </span>
        </div>
      )}

      {/* Message indicating drop is disabled */}
      {isDragActive && isDropDisabled && !isDeleteMoveMode && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-20 rounded-md">
          <span className="text-white text-center text-sm font-semibold px-2">
            Cannot drop here. Edit pad to manage multiple sounds.
          </span>
        </div>
      )}

      {/* Delete/move mode - Show deletion icon or drag handle (except for special pads) */}
      {isDeleteMoveMode && soundCount > 0 && !isSpecialPad && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <span className="text-red-500 dark:text-red-400 text-2xl">
            {isDragging ? "•••" : "×"}
          </span>
        </div>
      )}
    </div>
  );
};

export default React.memo(Pad);
