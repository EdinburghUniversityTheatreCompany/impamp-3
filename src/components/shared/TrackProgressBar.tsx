/**
 * Shared Track Progress Bar Component
 *
 * Displays a progress bar representing playback progress.
 * Used in both Active Tracks and Armed Tracks panels.
 *
 * @module components/shared/TrackProgressBar
 */

"use client";

import React from "react";

interface TrackProgressBarProps {
  /**
   * Progress value from 0 to 1
   */
  progress: number;

  /**
   * Whether the track is currently fading out
   */
  isFading?: boolean;

  /**
   * Optional additional CSS classes
   */
  className?: string;

  /**
   * Height of the progress bar in pixels (defaults to 8px/2rem)
   */
  height?: number;
}

/**
 * Track progress bar component used to visualize playback progress
 *
 * @param props - Component props
 * @returns Progress bar component
 */
const TrackProgressBar: React.FC<TrackProgressBarProps> = ({
  progress,
  isFading = false,
  className = "",
  height = 8,
}) => {
  // Ensure progress stays between 0 and 1
  const normalizedProgress = Math.min(1, Math.max(0, progress));

  return (
    <div
      className={`w-full bg-gray-200 dark:bg-gray-600 rounded-full ${className}`}
      style={{ height: `${height}px` }}
    >
      <div
        className={`h-full rounded-full transition-all duration-100 ${
          isFading ? "bg-blue-400" : "bg-blue-500"
        }`}
        style={{ width: `${normalizedProgress * 100}%` }}
        role="progressbar"
        aria-valuenow={normalizedProgress * 100}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  );
};

export default TrackProgressBar;
