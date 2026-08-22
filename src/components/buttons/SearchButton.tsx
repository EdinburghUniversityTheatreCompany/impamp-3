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
import { useIsApplePlatform } from "@/hooks/useIsApplePlatform";
import { armModifierLabel } from "@/lib/platform";
import MagnifierFillIcon from "@/components/icons/MagnifierFillIcon";

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

  // The shortcut itself is registered globally in useKeyboardListener; this
  // only has to name the modifier the reader's keyboard actually has.
  const modifier = armModifierLabel(useIsApplePlatform());

  return (
    <button
      onClick={openSearchModal}
      className={`flex items-center justify-center p-2 w-9 h-9 rounded-full transition-colors duration-200 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 ${className}`}
      aria-label="Search sounds"
      title={`Search sounds (${modifier}+F)`}
      data-testid="search-button"
    >
      <MagnifierFillIcon className="h-4 w-4" />
    </button>
  );
};

export default SearchButton;
