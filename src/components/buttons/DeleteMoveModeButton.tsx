/**
 * Delete/Move Mode Button
 *
 * Button that toggles delete/move mode
 *
 * @module components/buttons/DeleteMoveModeButton
 */

"use client";

import React from "react";
import { useToggleMode } from "@/hooks/useToggleMode";

interface DeleteMoveModeButtonProps {
  className?: string;
}

/**
 * Button that toggles delete/move mode for rearranging and deleting pads
 *
 * @param props - Component props
 * @returns Button component
 */
const DeleteMoveModeButton: React.FC<DeleteMoveModeButtonProps> = ({
  className = "",
}) => {
  const { isDeleteMoveMode, toggleDeleteMoveMode } = useToggleMode();

  return (
    <button
      onClick={toggleDeleteMoveMode}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 ${
        isDeleteMoveMode
          ? "bg-red-500 text-white hover:bg-red-600"
          : "bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
      } ${className}`}
      aria-label="Toggle delete and move mode"
      title="Toggle delete and move mode"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        fill="currentColor"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        {/* Combined trash and move icon */}
        <path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5ZM11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1H11Z" />
        {/* Arrows for move/swap */}
        <path d="M4.5 6.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0V7a.5.5 0 0 1 .5-.5zm2.5 2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5zm4.5-2.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0V7a.5.5 0 0 1 .5-.5z" />
      </svg>
    </button>
  );
};

export default DeleteMoveModeButton;
