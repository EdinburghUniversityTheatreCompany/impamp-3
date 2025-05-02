/**
 * Shared Panel Header Component
 *
 * Displays a consistent header for track panels with title and optional help text.
 * Used in both Active Tracks and Armed Tracks panels.
 *
 * @module components/shared/PanelHeader
 */

"use client";

import React, { ReactNode } from "react";

interface PanelHeaderProps {
  /**
   * Panel title text
   */
  title: string;

  /**
   * Optional help text to display on the right side of the header
   */
  helpText?: ReactNode;

  /**
   * Optional actions to display next to the title (e.g., settings button)
   */
  actions?: ReactNode;

  /**
   * Optional additional CSS classes for the header container
   */
  className?: string;
}

/**
 * Consistent header component for panel sections
 */
const PanelHeader: React.FC<PanelHeaderProps> = ({
  title,
  helpText,
  actions,
  className = "",
}) => {
  return (
    <div className={`flex items-center justify-between mb-2 ${className}`}>
      <div className="flex items-center">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
          {title}
        </h2>
        {actions && <div className="ml-2">{actions}</div>}
      </div>

      {helpText && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {helpText}
        </div>
      )}
    </div>
  );
};

export default PanelHeader;
