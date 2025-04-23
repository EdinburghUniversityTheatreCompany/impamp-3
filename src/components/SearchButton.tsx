"use client";

import React from "react";
import { useSearchModal } from "./SearchModalProvider";

const SearchButton: React.FC = () => {
  const { openSearchModal } = useSearchModal();

  return (
    <button
      onClick={openSearchModal}
      className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
      aria-label="Search sounds"
      title="Search sounds (Ctrl+F)"
      data-testid="search-button"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-5 w-5 text-gray-700 dark:text-gray-300"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
        />
      </svg>
    </button>
  );
};

export default SearchButton;
