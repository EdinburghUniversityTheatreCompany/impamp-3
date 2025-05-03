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
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        fill="currentColor"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        {/* Edit/Pencil icon */}
        <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" />
      </svg>
    </button>
  );
};

export default EditModeButton;
