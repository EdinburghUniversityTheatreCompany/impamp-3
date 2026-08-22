/**
 * Help Button
 *
 * Button that opens the help modal
 *
 * @module components/buttons/HelpButton
 */

"use client";

import React from "react";
import { openHelpModal } from "@/lib/uiUtils";
import QuestionCircleIcon from "@/components/icons/QuestionCircleIcon";

interface HelpButtonProps {
  className?: string;
}

/**
 * Button that opens the help modal with keyboard shortcut information
 *
 * @param props - Component props
 * @returns Button component
 */
const HelpButton: React.FC<HelpButtonProps> = ({ className = "" }) => {
  const handleOpenHelp = () => {
    openHelpModal(); // Use the centralized utility function
  };

  return (
    <button
      onClick={handleOpenHelp}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 ${className}`}
      aria-label="Help"
      title="Help (Shift+?)"
      data-testid="help-button"
    >
      <QuestionCircleIcon className="h-6 w-6" />
    </button>
  );
};

export default HelpButton;
