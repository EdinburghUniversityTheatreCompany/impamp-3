/**
 * Search Provider
 *
 * Provides context for search functionality across the application
 *
 * @module components/search/SearchProvider
 */

"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
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

  // Stable identities. `openSearchModal` is a dependency of the global keydown
  // handler in `useKeyboardListener`, which is in turn the dependency of the
  // effect that registers the window listeners — so a fresh function on every
  // render tore down and re-added the app's keyboard handlers. Bounded today,
  // because this only re-renders when the flag flips, but one `useState` away
  // from doing it per keystroke, and any key held across the swap loses its
  // `keyup` pairing.
  const openSearchModal = useCallback(() => setIsSearchModalOpen(true), []);
  const closeSearchModal = useCallback(() => setIsSearchModalOpen(false), []);

  const value = useMemo(
    () => ({ isSearchModalOpen, openSearchModal, closeSearchModal }),
    [isSearchModalOpen, openSearchModal, closeSearchModal],
  );

  return (
    <SearchContext.Provider value={value}>
      {children}
      <SearchModal isOpen={isSearchModalOpen} onClose={closeSearchModal} />
    </SearchContext.Provider>
  );
}
