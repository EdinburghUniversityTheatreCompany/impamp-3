/**
 * Search Modal
 *
 * Modal for searching and playing sounds across the active profile
 *
 * @module components/search/SearchModal
 */

"use client";

import React, { useRef, useEffect, useState } from "react";
import { triggerPad, ensureAudioContextActive } from "@/lib/audio";
import { playbackStoreActions } from "@/store/playbackStore";
import { useSearch, type SearchResult } from "@/hooks/useSearch";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";
import { useIsApplePlatform } from "@/hooks/useIsApplePlatform";
import { armModifierLabel, hasArmModifier } from "@/lib/platform";
import { extractPadPlaybackSettings } from "@/lib/db";
import MagnifierIcon from "@/components/icons/MagnifierIcon";
import XIcon from "@/components/icons/XIcon";

/** A refusal, and the exact situation it was raised in. */
interface ActivationNotice {
  /** The term in the box at the time. */
  term: string;
  /** The result list on screen at the time, by identity. */
  results: SearchResult[];
  /** What to tell the operator. */
  text: string;
}

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
  const {
    searchTerm,
    setSearchTerm,
    results,
    isLoading,
    isStale,
    resultsTerm,
  } = useSearch();

  // Why the last press did nothing, when it did nothing. A refusal the
  // operator cannot see is the same as no refusal at all.
  //
  // Stored with the term and the result list it was raised against, and read
  // back only while both still hold. A notice is about one press against one
  // set of results: typing again, or the results catching up, both answer it,
  // and "still searching" left up after the search finished would be a second
  // lie on top of the first. Expiring it by comparison rather than by clearing
  // it from an effect keeps that out of the render cycle entirely.
  const [notice, setNotice] = useState<ActivationNotice | null>(null);
  const activationNotice =
    notice && notice.term === searchTerm && notice.results === results
      ? notice.text
      : null;

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
          // `SearchResult` embeds `PadPlaybackSettings`, so the one funnel
          // takes it whole. This used to be an eight-field literal, one of
          // three copies of the same list between a pad and this modal.
          ...extractPadPlaybackSettings(result),
          padIndex: result.padIndex,
          name: result.name,
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
        ...extractPadPlaybackSettings(result),
        key: armedKey,
        name: result.name,
        padInfo: {
          profileId: result.profileId,
          bankId: result.bankId,
          padIndex: result.padIndex,
        },
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

  // The keyboard route from Ctrl+F to a cue, with no Tab in it.
  //
  // The chord below hangs off the result `<button>`, but the input keeps focus
  // after typing — so arming meant typing, tabbing past whatever lay between,
  // and only then holding the chord. Plain Enter in the input did nothing at
  // all, because nothing activated the first result. Under pressure the
  // fastest path has to be: type, then Enter to play or the chord to arm.
  //
  // `preventDefault` fires only on a key this actually consumed. It is what
  // `useKeyboardListener` reads to know something nearer the target claimed
  // the press, so claiming Enter with no result to activate would swallow the
  // emergency cue behind an open, empty search box.
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;

    const first = results[0];
    if (!first) return;

    // From here on the press is this modal's, whatever comes of it: there is a
    // result on screen and a hint above it saying Enter plays that result, so
    // handing the key onwards would fire an emergency cue from behind an open
    // search box. Every branch below therefore says something instead.
    e.preventDefault();

    // The results have not caught up with the box. `useSearch` waits 300 ms
    // before it reads anything and leaves the previous term's results up
    // meanwhile — with `isLoading` false throughout — so acting on `results[0]`
    // here fires the query the operator has already replaced. Refusing is the
    // only safe answer: a cue is irreversible, and this is exactly the flow
    // (type, Enter, no Tab) the handler was added for.
    if (isStale) {
      setNotice({
        term: searchTerm,
        results,
        text: `Still searching. These results are for “${resultsTerm}” — press Enter again in a moment.`,
      });
      return;
    }

    activateResult(first, hasArmModifier(e));
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
            <MagnifierIcon className="h-5 w-5" />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleInputKeyDown}
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
            <XIcon className="h-6 w-6" />
          </button>
        </div>

        {activationNotice && (
          <div
            role="alert"
            data-testid="search-activation-notice"
            className="px-4 py-2 text-xs text-yellow-800 dark:text-yellow-200 bg-yellow-50 dark:bg-yellow-900/20"
          >
            {activationNotice}
          </div>
        )}

        {/* Outside the scrolling list on purpose: a hint that scrolls away
            with the results is not a hint. Said here rather than in a tooltip
            on one result, because the chord is only reachable without a Tab
            thanks to the *input* listening for it, which an operator has no
            way to guess from a list of pads. */}
        {!isLoading && results.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-4 pt-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700 pb-2">
            <span>
              {results.length} {results.length === 1 ? "result" : "results"}
            </span>
            {/* The promise is withdrawn while the list is out of date, because
                the promise is the whole reason an operator presses Enter
                without reading the list first. */}
            <span data-testid="search-activation-hint">
              {isStale
                ? "Searching…"
                : `Enter plays the first result, ${modifier}+Enter arms it`}
            </span>
          </div>
        )}

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
