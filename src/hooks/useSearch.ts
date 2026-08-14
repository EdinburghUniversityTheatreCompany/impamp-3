/**
 * Search Hook
 *
 * Provides search functionality for finding pads across the active profile
 *
 * @module hooks/useSearch
 */

import { useState, useEffect, useRef } from "react";
import { useProfileStore } from "@/store/profileStore";
import { getAudioFile, PlaybackType } from "@/lib/db";
import { getAllPadConfigurationsForProfile } from "@/lib/importExport";
import { convertIndexToBankNumber } from "@/lib/bankUtils";

/**
 * Search result item representing a match
 */
export interface SearchResult {
  /** Profile ID the result belongs to */
  profileId: number;
  /** Page/bank index containing the result */
  pageIndex: number;
  /** Pad index within the page */
  padIndex: number;
  /** Pad display name */
  name: string;
  /** IDs of audio files assigned to this pad */
  audioFileIds: number[];
  /** Playback strategy for this pad */
  playbackType: PlaybackType;
  /** Trim settings per audio file */
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  /** Per-sound manual gain in dB, keyed by audio file ID */
  audioGainSettings?: Record<number, number>;
  /** Whole-pad manual gain in dB */
  padGainDb?: number;
  /** Whether the pad is disabled and so cannot be played or armed */
  isDisabled: boolean;
  /** Original filename of the first audio file */
  originalFileName: string;
  /** Display name of the bank containing this pad */
  bankName: string;
}

/**
 * Options for the search hook
 */
export interface SearchOptions {
  /** Delay in milliseconds before search executes after input changes */
  debounceTime?: number;
}

/**
 * Custom hook for searching pads across the active profile
 *
 * @param searchOptions - Configuration options for the search
 * @returns Object containing search state and functions
 */
const NO_RESULTS: SearchResult[] = [];

export function useSearch(searchOptions: SearchOptions = {}) {
  const { debounceTime = 300 } = searchOptions;

  // State
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Get active profile from store
  const activeProfileId = useProfileStore((state) => state.activeProfileId);

  // Cache of audio file names, so each file is only read from IndexedDB once
  const audioFileNamesRef = useRef(new Map<number, string>());

  // Whether there is anything to search for at all. Used below to decide
  // whether the stored results are worth showing, instead of clearing them
  // from inside the effect: emptying the box is not an event that needs to
  // reach into state, it just means there is nothing to show.
  const hasQuery = searchTerm.trim().length > 0 && activeProfileId !== null;

  // Handle search
  useEffect(() => {
    if (!hasQuery) return;

    let cancelled = false;

    const searchPads = async () => {
      setIsLoading(true);
      try {
        // Get all pad configurations for the active profile
        const allPads =
          await getAllPadConfigurationsForProfile(activeProfileId);
        if (cancelled) return;

        // Create a map to store bank names by index
        const bankNames = new Map<number, string>();

        // Filter pads with audio files and matching names
        const searchResults: SearchResult[] = [];

        // Process each pad
        for (const pad of allPads) {
          // Ensure audioFileIds exists and is not empty
          if (!pad.audioFileIds || pad.audioFileIds.length === 0) continue;

          // Try to get bank name if we haven't loaded it yet
          if (!bankNames.has(pad.pageIndex)) {
            try {
              // You might need to implement a function to get bank name
              // For now, we'll use a default format
              bankNames.set(
                pad.pageIndex,
                `Bank ${convertIndexToBankNumber(pad.pageIndex)}`,
              );
            } catch (error) {
              console.error(
                `Error getting bank name for index ${pad.pageIndex}:`,
                error,
              );
              bankNames.set(
                pad.pageIndex,
                `Bank ${convertIndexToBankNumber(pad.pageIndex)}`,
              );
            }
          }

          // Get pad name
          const padName = pad.name || `Pad ${pad.padIndex + 1}`;
          const originalFileNames: string[] = [];
          let displayFileName = ""; // Store the first filename for display

          // Try to get all original file names, reusing previously cached names
          try {
            const nameCache = audioFileNamesRef.current;
            for (const audioId of pad.audioFileIds) {
              if (!nameCache.has(audioId)) {
                const audioFile = await getAudioFile(audioId);
                if (cancelled) return;
                if (audioFile) {
                  nameCache.set(audioId, audioFile.name);
                }
              }

              const fileName = nameCache.get(audioId);
              if (fileName) {
                originalFileNames.push(fileName);
                if (!displayFileName) {
                  // Store the first valid name for display
                  displayFileName = fileName;
                }
              }
            }
          } catch (error) {
            console.error(
              `Error getting audio files for pad ${pad.padIndex}:`,
              error,
            );
          }

          // Check if pad matches search term (pad name OR any original file name)
          const searchTermLower = searchTerm.toLowerCase();
          const nameMatches = padName.toLowerCase().includes(searchTermLower);
          const fileNameMatches = originalFileNames.some((name) =>
            name.toLowerCase().includes(searchTermLower),
          );

          if (nameMatches || fileNameMatches) {
            searchResults.push({
              profileId: activeProfileId,
              pageIndex: pad.pageIndex,
              padIndex: pad.padIndex,
              name: padName,
              audioFileIds: pad.audioFileIds,
              playbackType: pad.playbackType,
              audioTrimSettings: pad.audioTrimSettings,
              audioGainSettings: pad.audioGainSettings,
              padGainDb: pad.padGainDb,
              isDisabled: pad.isDisabled ?? false,
              originalFileName: displayFileName,
              bankName:
                bankNames.get(pad.pageIndex) ||
                `Bank ${convertIndexToBankNumber(pad.pageIndex)}`,
            });
          }
        }

        if (!cancelled) {
          setResults(searchResults);
        }
      } catch (error) {
        console.error("Error searching pads:", error);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    const debounceTimeout = setTimeout(() => {
      searchPads();
    }, debounceTime);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimeout);
    };
  }, [searchTerm, activeProfileId, debounceTime, hasQuery]);

  return {
    searchTerm,
    setSearchTerm,
    results: hasQuery ? results : NO_RESULTS,
    isLoading: hasQuery && isLoading,

    // Helper method to clear the search
    clearSearch: () => setSearchTerm(""),
  };
}
