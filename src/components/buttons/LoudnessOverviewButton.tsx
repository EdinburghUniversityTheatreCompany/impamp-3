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
import { SlidersIcon } from "@/components/icons";

interface LoudnessOverviewButtonProps {
  className?: string;
}

/**
 * Button that opens the loudness overview — a sortable table of every sound
 * on the active profile, showing what each will actually play at.
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
      <SlidersIcon className="h-6 w-6" />
    </button>
  );
};

export default LoudnessOverviewButton;
