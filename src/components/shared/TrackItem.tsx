/**
 * Shared Track Item Component
 *
 * Displays a single track item with progress, controls, and information.
 * Used in both Active Tracks and Armed Tracks panels.
 *
 * @module components/shared/TrackItem
 */

"use client";

import React from "react";
import { formatTime } from "@/utils/formatters";
import TrackProgressBar from "./TrackProgressBar";
import { useTrackControls } from "@/hooks/useTrackControls";
import CheckIcon from "@/components/icons/CheckIcon";
import FadeOutIcon from "@/components/icons/FadeOutIcon";
import PlayCircleIcon from "@/components/icons/PlayCircleIcon";
import XIcon from "@/components/icons/XIcon";

interface TrackItemProps {
  /**
   * Unique key for the track
   */
  trackKey: string;

  /**
   * Display name for the track
   */
  name: string;

  /**
   * Remaining playback time in seconds (only for active tracks)
   */
  remainingTime?: number;

  /**
   * Total duration in seconds
   */

  /**
   * Current playback progress (0 to 1)
   */
  progress?: number;

  /**
   * Whether the track is currently fading out
   */
  isFading?: boolean;

  /**
   * Whether this is an active track (playing) or armed track (queued)
   */
  isActive?: boolean;

  /**
   * An optional control rendered in the row's normal flow, immediately before
   * the remaining-time readout.
   *
   * This exists so a caller can add something to the row without overlaying
   * it. `PadTrackGroup`'s layer count used to be absolutely positioned over
   * the row, which put it straight on top of the last two digits of the
   * remaining time — the one number an operator most needs, on exactly the
   * kind of pad (a stacked one) where they most need it. A flow slot cannot
   * collide at a different font size, in dark mode, or at another width.
   *
   * Anything interactive placed here must call `stopPropagation()`, because
   * the row itself is clickable and stops the track.
   */
  badge?: React.ReactNode;

  /**
   * Callback for when the play button is clicked (for armed tracks)
   */
  onPlay?: () => void;

  /**
   * Callback for when the remove button is clicked (for armed tracks)
   */
  onRemove?: () => void;
}

/**
 * Shared track item component for displaying both active and armed tracks
 */
const TrackItem: React.FC<TrackItemProps> = ({
  trackKey,
  name,
  remainingTime,
  progress = 0,
  isFading = false,
  isActive = false,
  badge,
  onPlay,
  onRemove,
}) => {
  const { stopTrack, fadeOutTrack, getFadeoutDuration } = useTrackControls();

  /**
   * Handle clicking on the track item itself
   * For active tracks, stops the track immediately
   */
  const handleItemClick = () => {
    if (isActive) {
      stopTrack(trackKey);
    }
  };

  /**
   * Handle clicking the fade button
   * For active tracks, fades out the track with the current fadeout duration
   */
  const handleFadeClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // Prevent parent onClick from firing
    if (isActive) {
      fadeOutTrack(trackKey);
    }
  };

  /**
   * Handle clicking the play button for armed tracks
   */
  const handlePlayClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // Prevent parent onClick from firing
    if (onPlay) {
      onPlay();
    }
  };

  /**
   * Handle clicking the remove button for armed tracks
   */
  const handleRemoveClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // Prevent parent onClick from firing
    if (onRemove) {
      onRemove();
    }
  };

  return (
    <div
      className={`flex items-center space-x-3 p-3 rounded shadow-sm cursor-pointer
        transition-colors ${
          isFading
            ? "bg-blue-50 dark:bg-blue-900/30 animate-pulse"
            : isActive
              ? "bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
              : "bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 border-l-4 border-amber-500"
        }`}
      onClick={handleItemClick}
      aria-label={isActive ? `Stop playing ${name}` : `Track: ${name}`}
      data-testid={isActive ? "active-track-item" : "armed-track-item"}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-800 dark:text-gray-200 truncate">
          {name}
          {isFading && (
            <span className="ml-2 text-xs text-blue-500 dark:text-blue-400 font-normal">
              fading out...
            </span>
          )}
          {!isActive && (
            <span className="ml-2 text-xs text-amber-500 dark:text-amber-400 font-normal">
              armed
            </span>
          )}
        </div>

        {/* Show progress bar for active tracks */}
        {isActive && (
          <TrackProgressBar
            progress={progress}
            isFading={isFading}
            className="mt-2"
          />
        )}
      </div>

      {/* Caller-supplied control, in flow so it cannot cover the time */}
      {badge}

      {/* Time display (for active tracks) */}
      {isActive && remainingTime !== undefined && (
        <div className="text-sm text-gray-600 dark:text-gray-300 min-w-[50px] text-right font-mono">
          {formatTime(remainingTime)}
        </div>
      )}

      {/* Action buttons */}
      {isActive ? (
        // Active track buttons (fade out)
        !isFading ? (
          <button
            onClick={handleFadeClick}
            className="bg-blue-500 hover:bg-blue-600 text-white p-1.5 rounded flex-shrink-0"
            aria-label={`Fade out ${name}`}
            title={`Fade out over ${getFadeoutDuration()} ${
              getFadeoutDuration() === 1 ? "second" : "seconds"
            }`}
          >
            <FadeOutIcon className="h-5 w-5" />
          </button>
        ) : (
          // Fading indicator
          <div
            className="p-1.5 rounded flex-shrink-0 text-blue-400"
            title="Fading out..."
          >
            <CheckIcon className="h-5 w-5" />
          </div>
        )
      ) : (
        // Armed track buttons (play and remove)
        <div className="flex space-x-2">
          <button
            onClick={handlePlayClick}
            className="bg-green-500 hover:bg-green-600 text-white p-1.5 rounded flex-shrink-0"
            aria-label={`Play ${name}`}
          >
            <PlayCircleIcon className="h-5 w-5" />
          </button>
          <button
            onClick={handleRemoveClick}
            className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded flex-shrink-0"
            aria-label={`Remove ${name} from queue`}
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
};

export default TrackItem;
