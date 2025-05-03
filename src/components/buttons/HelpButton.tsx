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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-6 w-6"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </button>
  );
};

export default HelpButton;
