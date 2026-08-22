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
import { TrashMoveIcon } from "@/components/icons";

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
      <TrashMoveIcon className="h-4 w-4" />
    </button>
  );
};

export default DeleteMoveModeButton;
