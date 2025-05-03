/**
 * Search Button
 *
 * Button that opens the search modal
 *
 * @module components/buttons/SearchButton
 */

"use client";

import React from "react";
import { useSearchContext } from "@/components/search";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";

interface SearchButtonProps {
  className?: string;
}

/**
 * Button that opens the search modal
 *
 * @param props - Component props
 * @returns Button component
 */
const SearchButton: React.FC<SearchButtonProps> = ({ className = "" }) => {
  const { openSearchModal } = useSearchContext();

  // Register keyboard shortcut (Ctrl+F)
  useKeyboardShortcut({
    keys: ["Control", "f"],
    callback: () => openSearchModal(),
    preventDefault: true,
  });

  return (
    <button
      onClick={openSearchModal}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 ${className}`}
      aria-label="Search sounds"
      title="Search sounds (Ctrl+F)"
      data-testid="search-button"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        fill="currentColor"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        {/* Search icon */}
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z" />
      </svg>
    </button>
  );
};

export default SearchButton;
