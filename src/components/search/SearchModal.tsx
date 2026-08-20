/**
 * Search Modal
 *
 * Modal for searching and playing sounds across the active profile
 *
 * @module components/search/SearchModal
 */

"use client";

import React, { useRef, useEffect } from "react";
import { triggerPad, ensureAudioContextActive } from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { useSearch, type SearchResult } from "@/hooks/useSearch";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";
import { useIsApplePlatform } from "@/hooks/useIsApplePlatform";
import { armModifierLabel, hasArmModifier } from "@/lib/platform";

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

  // How to name the arm chord in the per-result tooltip
  const modifier = armModifierLabel(useIsApplePlatform());

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

      await triggerPad(
        {
          padIndex: result.padIndex,
          audioFileIds: result.audioFileIds,
          playbackType: result.playbackType,
          name: result.name,
          audioTrimSettings: result.audioTrimSettings,
          audioGainSettings: result.audioGainSettings,
          padGainDb: result.padGainDb,
        },
        {
          activeProfileId: result.profileId,
          currentBankId: result.bankId,
        },
        { logPrefix: "[SearchModal] search result" },
      );

      // Close the modal after initiating playback
      onClose();
    } catch (error) {
      console.error("Error playing sound:", error);
    }
  };

  // Function to arm a sound when the arm chord is held
  const handleArmSound = (result: SearchResult) => {
    try {
      // Create a unique key for this armed track
      const armedKey = `armed-${result.profileId}-${result.bankId}-${result.padIndex}`;

      // Add to armed tracks store
      playbackStoreActions.armTrack(armedKey, {
        key: armedKey,
        name: result.name,
        padInfo: {
          profileId: result.profileId,
          bankId: result.bankId,
          padIndex: result.padIndex,
        },
        audioFileIds: result.audioFileIds,
        playbackType: result.playbackType,
        audioTrimSettings: result.audioTrimSettings,
        audioGainSettings: result.audioGainSettings,
        padGainDb: result.padGainDb,
      });

      console.log(`Armed track from search: ${result.name}`);

      // Close the modal after arming
      onClose();
    } catch (error) {
      console.error("Error arming sound:", error);
    }
  };

  // Handle result interaction - play, or arm when the arm chord is held
  const activateResult = (result: SearchResult, withArmModifier: boolean) => {
    // Disabled pads are listed so they can be found, but neither play nor arm
    if (result.isDisabled) {
      console.log(`[SearchModal] Pad "${result.name}" is disabled, ignoring.`);
      return;
    }
    if (withArmModifier) {
      handleArmSound(result);
    } else {
      handlePlaySound(result);
    }
  };

  // Ctrl+Enter — or Cmd+Enter on a Mac — arms, mirroring the click chord.
  //
  // A <button> already fires its onClick from Enter and Space, so the plain
  // case needs nothing. The chord does: preventDefault is what stops the
  // browser synthesising that click as well, which would otherwise arm the cue
  // and then immediately play it.
  const handleResultKeyDown = (
    e: React.KeyboardEvent,
    result: SearchResult,
  ) => {
    if (e.key !== "Enter" || !hasArmModifier(e)) return;
    e.preventDefault();
    activateResult(result, true);
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
                // A real <button>, not a div with a role bolted on: it brings
                // its own tab stop and its own Enter/Space activation, and it
                // is what makes `aria-disabled` mean anything — on the div this
                // used to be, with no role, the attribute was inert.
                //
                // `aria-disabled` rather than `disabled` on purpose. Disabled
                // pads are listed so they can still be *found*, and a truly
                // disabled button drops out of the tab order and goes
                // unannounced, which would hide them from the people most
                // reliant on the search.
                <button
                  type="button"
                  key={`${result.pageIndex}-${result.padIndex}`}
                  onClick={(e) => activateResult(result, hasArmModifier(e))}
                  onKeyDown={(e) => handleResultKeyDown(e, result)}
                  className={`w-full text-left bg-white dark:bg-gray-700 rounded p-3 shadow transition-colors ${
                    result.isDisabled
                      ? "opacity-60 cursor-not-allowed"
                      : "cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30"
                  }`}
                  data-testid="search-result-item"
                  aria-disabled={result.isDisabled}
                  title={
                    result.isDisabled
                      ? "This pad is disabled."
                      : `Click or press Enter to play. ${modifier}+Click or ${modifier}+Enter to arm track.`
                  }
                >
                  {/* Spans rather than divs: a <button> may only contain
                      phrasing content, and `block` restores the layout the
                      divs gave when this was one. */}
                  <span className="block font-medium text-gray-900 dark:text-white">
                    <span className={result.isDisabled ? "line-through" : ""}>
                      {result.name}
                    </span>
                    {result.isDisabled && (
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wide bg-gray-600 text-white px-1 rounded align-middle dark:bg-gray-500">
                        Off
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {result.bankName}
                  </span>
                  {result.originalFileName &&
                    result.originalFileName !== result.name && (
                      <span className="block text-xs text-gray-400 dark:text-gray-500 mt-1 italic">
                        {result.originalFileName}
                      </span>
                    )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SearchModal;
