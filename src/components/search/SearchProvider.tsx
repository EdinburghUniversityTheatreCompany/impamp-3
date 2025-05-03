/**
 * Search Provider
 *
 * Provides context for search functionality across the application
 *
 * @module components/search/SearchProvider
 */

"use client";

import React, { createContext, useContext, useState } from "react";
import SearchModal from "./SearchModal";

// Create a context to share search functionality across components
interface SearchContextType {
  isSearchModalOpen: boolean;
  openSearchModal: () => void;
  closeSearchModal: () => void;
}

const SearchContext = createContext<SearchContextType | undefined>(undefined);

/**
 * Hook for accessing search context
 *
 * @returns The search context object
 * @throws Error if used outside of SearchProvider
 */
export function useSearchContext(): SearchContextType {
  const context = useContext(SearchContext);

  if (context === undefined) {
    throw new Error("useSearchContext must be used within a SearchProvider");
  }

  return context;
}

interface SearchProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component for search functionality
 *
 * @param props - Component props
 * @returns Provider component with children
 */
export function SearchProvider({
  children,
}: SearchProviderProps): React.ReactElement {
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);

  const openSearchModal = () => setIsSearchModalOpen(true);
  const closeSearchModal = () => setIsSearchModalOpen(false);

  const value = {
    isSearchModalOpen,
    openSearchModal,
    closeSearchModal,
  };

  return (
    <SearchContext.Provider value={value}>
      {children}
      <SearchModal isOpen={isSearchModalOpen} onClose={closeSearchModal} />
    </SearchContext.Provider>
  );
}
