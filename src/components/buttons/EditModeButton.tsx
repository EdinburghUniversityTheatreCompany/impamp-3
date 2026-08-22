/**
 * Edit Mode Button
 *
 * Button that toggles edit mode
 *
 * @module components/buttons/EditModeButton
 */

"use client";

import React from "react";
import { useToggleMode } from "@/hooks/useToggleMode";
import { PencilFillIcon } from "@/components/icons";

interface EditModeButtonProps {
  className?: string;
}

/**
 * Button that toggles edit mode for configuring pads and banks
 *
 * @param props - Component props
 * @returns Button component
 */
const EditModeButton: React.FC<EditModeButtonProps> = ({ className = "" }) => {
  const { isEditMode, setEditMode } = useToggleMode();

  const handleToggleEditMode = () => {
    setEditMode(!isEditMode);
  };

  return (
    <button
      onClick={handleToggleEditMode}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 ${
        isEditMode
          ? "bg-amber-500 text-white hover:bg-amber-600"
          : "bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
      } ${className}`}
      aria-label="Toggle edit mode"
      title="Toggle edit mode"
    >
      <PencilFillIcon className="h-4 w-4" />
    </button>
  );
};

export default EditModeButton;
