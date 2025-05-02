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
  totalDuration?: number;

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  totalDuration, // Not currently used but kept for future use
  progress = 0,
  isFading = false,
  isActive = false,
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15.536 8.464a5 5 0 010 7.072M12 9.5l-3 3L12 15.5m4.5-4.5h-7.5"
              />
            </svg>
          </button>
        ) : (
          // Fading indicator
          <div
            className="p-1.5 rounded flex-shrink-0 text-blue-400"
            title="Fading out..."
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
          <button
            onClick={handleRemoveClick}
            className="bg-red-500 hover:bg-red-600 text-white p-1.5 rounded flex-shrink-0"
            aria-label={`Remove ${name} from queue`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default TrackItem;
