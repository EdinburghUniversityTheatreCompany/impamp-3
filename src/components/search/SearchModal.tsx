/**
 * Search Modal
 *
 * Modal for searching and playing sounds across the active profile
 *
 * @module components/search/SearchModal
 */

"use client";

import React, { useRef, useEffect } from "react";
import { triggerAudioForPad, ensureAudioContextActive } from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { useSearch, type SearchResult } from "@/hooks/useSearch";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal for searching and playing sounds
 *
 * @param props - Component props
 * @returns Modal component
 */
const SearchModal: React.FC<SearchModalProps> = ({ isOpen, onClose }) => {
  // Search functionality
  const { searchTerm, setSearchTerm, results, isLoading } = useSearch();

  // Refs
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  // Register Escape key handler with high priority
  useKeyboardShortcut({
    keys: ["Escape"],
    callback: () => onClose(),
    isEnabled: isOpen,
    preventDefault: true,
    stopPropagation: true, // Important to prevent the global Escape handler (panic button)
  });

  // Handle clicking outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        modalRef.current &&
        !modalRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  // Function to play sound when clicked
  const handlePlaySound = async (result: SearchResult) => {
    try {
      // Resume audio context first
      ensureAudioContextActive();

      // Call the centralized trigger function
      await triggerAudioForPad({
        padIndex: result.padIndex,
        audioFileIds: result.audioFileIds,
        playbackType: result.playbackType,
        activeProfileId: result.profileId,
        currentPageIndex: result.pageIndex,
        name: result.name,
      });

      // Close the modal after initiating playback
      onClose();
    } catch (error) {
      console.error("Error playing sound:", error);
    }
  };

  // Function to arm a sound when Ctrl+Clicked
  const handleArmSound = (result: SearchResult) => {
    try {
      // Create a unique key for this armed track
      const armedKey = `armed-${result.profileId}-${result.pageIndex}-${result.padIndex}`;

      // Add to armed tracks store
      playbackStoreActions.armTrack(armedKey, {
        key: armedKey,
        name: result.name,
        padInfo: {
          profileId: result.profileId,
          pageIndex: result.pageIndex,
          padIndex: result.padIndex,
        },
        audioFileIds: result.audioFileIds,
        playbackType: result.playbackType,
      });

      console.log(`Armed track from search: ${result.name}`);

      // Close the modal after arming
      onClose();
    } catch (error) {
      console.error("Error arming sound:", error);
    }
  };

  // Handle result interaction - play or arm
  const handleResultClick = (e: React.MouseEvent, result: SearchResult) => {
    if (e.ctrlKey) {
      handleArmSound(result);
    } else {
      handlePlaySound(result);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      data-testid="search-modal-backdrop"
    >
      <div
        ref={modalRef}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        data-testid="search-modal"
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center">
          <div className="mr-2 text-gray-500 dark:text-gray-400">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
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
          </div>
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search sounds..."
            className="w-full p-2 bg-transparent border-0 focus:ring-0 text-gray-900 dark:text-white text-lg"
            autoComplete="off"
            data-testid="search-input"
          />
          <button
            onClick={onClose}
            className="ml-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close search"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-2">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              Searching...
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              {searchTerm ? "No sounds found" : "Type to search sounds"}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2">
              {results.map((result) => (
                <div
                  key={`${result.pageIndex}-${result.padIndex}`}
                  onClick={(e) => handleResultClick(e, result)}
                  className="bg-white dark:bg-gray-700 rounded p-3 shadow cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                  data-testid="search-result-item"
                  title={`Click to play. Ctrl+Click to arm track.`}
                >
                  <div className="font-medium text-gray-900 dark:text-white">
                    {result.name}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {result.bankName}
                  </div>
                  {result.originalFileName &&
                    result.originalFileName !== result.name && (
                      <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 italic">
                        {result.originalFileName}
                      </div>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchModal;
