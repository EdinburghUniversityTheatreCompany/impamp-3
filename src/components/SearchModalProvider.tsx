'use client';

import React, { createContext, useContext, useState } from 'react';
import SearchModal from './SearchModal';

// Define the context type
interface SearchModalContextType {
  isSearchModalOpen: boolean;
  openSearchModal: () => void;
  closeSearchModal: () => void;
}

// Create context with default values
const SearchModalContext = createContext<SearchModalContextType>({
  isSearchModalOpen: false,
  openSearchModal: () => {},
  closeSearchModal: () => {},
});

// Hook to use search modal context
export const useSearchModal = () => useContext(SearchModalContext);

// Provider component
export function SearchModalProvider({ children }: { children: React.ReactNode }) {
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);

  const openSearchModal = () => {
    setIsSearchModalOpen(true);
  };

  const closeSearchModal = () => {
    setIsSearchModalOpen(false);
  };

  return (
    <SearchModalContext.Provider
      value={{
        isSearchModalOpen,
        openSearchModal,
        closeSearchModal,
      }}
    >
      {children}
      <SearchModal isOpen={isSearchModalOpen} onClose={closeSearchModal} />
    </SearchModalContext.Provider>
  );
}
