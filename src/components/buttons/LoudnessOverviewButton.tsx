/**
 * Loudness Overview Button
 *
 * Button that opens the loudness overview modal
 *
 * @module components/buttons/LoudnessOverviewButton
 */

"use client";

import React from "react";
import { openLoudnessOverviewModal } from "@/lib/uiUtils";

interface LoudnessOverviewButtonProps {
  className?: string;
}

/**
 * Button that opens the loudness overview — a sortable table of every sound
 * on the active profile, showing what each will actually play at.
 *
 * @param props - Component props
 * @returns Button component
 */
const LoudnessOverviewButton: React.FC<LoudnessOverviewButtonProps> = ({
  className = "",
}) => {
  const handleOpen = () => {
    openLoudnessOverviewModal();
  };

  return (
    <button
      onClick={handleOpen}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 ${className}`}
      aria-label="Loudness overview"
      title="Loudness overview"
      data-testid="loudness-overview-button"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-6 w-6"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        {/* Three sliders, evoking per-sound gain controls */}
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 6h6m4 0h6M4 6a2 2 0 104 0 2 2 0 00-4 0zM4 18h10m4 0h2M4 18a2 2 0 104 0 2 2 0 00-4 0zM4 12h2m4 0h10M14 12a2 2 0 104 0 2 2 0 00-4 0z"
        />
      </svg>
    </button>
  );
};

export default LoudnessOverviewButton;
