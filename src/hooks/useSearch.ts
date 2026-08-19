/**
 * Search Hook
 *
 * Provides search functionality for finding pads across the active profile
 *
 * @module hooks/useSearch
 */

import { useState, useEffect, useRef } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  getAudioFileMetadata,
  getAllPageMetadataForProfile,
  PlaybackType,
} from "@/lib/db";
import { getAllPadConfigurationsForProfile } from "@/lib/importExport";
import { convertIndexToBankNumber } from "@/lib/bankUtils";

/**
 * Search result item representing a match
 */
export interface SearchResult {
  /** Profile ID the result belongs to */
  profileId: number;
  /** Identity of the bank containing the result, used to play the pad */
  bankId: string;
  /** Position of the bank containing the result, used to navigate to it */
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
        // Get all pad configurations for the active profile, plus the bank
        // metadata pads no longer carry a position of their own — a pad only
        // knows its bank's identity, and the position it navigates to comes
        // from looking that identity up.
        const [allPads, allBanks] = await Promise.all([
          getAllPadConfigurationsForProfile(activeProfileId),
          getAllPageMetadataForProfile(activeProfileId),
        ]);
        if (cancelled) return;

        const bankByBankId = new Map(
          allBanks.map((bank) => [bank.bankId, bank]),
        );

        // Create a map to store bank names by identity
        const bankNames = new Map<string, string>();

        // Filter pads with audio files and matching names
        const searchResults: SearchResult[] = [];

        // Warm the name cache for everything this search will ask about, in a
        // single cursor pass over the ids not already known.
        const nameCache = audioFileNamesRef.current;
        const unknownIds = [
          ...new Set(
            allPads
              .flatMap((pad) => pad.audioFileIds ?? [])
              .filter((id) => !nameCache.has(id)),
          ),
        ];
        if (unknownIds.length > 0) {
          const metadata = await getAudioFileMetadata(unknownIds);
          if (cancelled) return;
          for (const [id, file] of metadata) nameCache.set(id, file.name);
        }

        // Process each pad
        for (const pad of allPads) {
          // Ensure audioFileIds exists and is not empty
          if (!pad.audioFileIds || pad.audioFileIds.length === 0) continue;

          // A pad naming a bank this profile no longer has (mid-sync, or a
          // stale read) has nowhere to navigate to; skip it rather than
          // showing a result Enter can't reach.
          const bank = bankByBankId.get(pad.bankId);
          if (!bank) continue;

          // Try to get bank name if we haven't loaded it yet
          if (!bankNames.has(pad.bankId)) {
            try {
              // You might need to implement a function to get bank name
              // For now, we'll use a default format
              bankNames.set(
                pad.bankId,
                `Bank ${convertIndexToBankNumber(bank.pageIndex)}`,
              );
            } catch (error) {
              console.error(
                `Error getting bank name for bank ${pad.bankId}:`,
                error,
              );
              bankNames.set(
                pad.bankId,
                `Bank ${convertIndexToBankNumber(bank.pageIndex)}`,
              );
            }
          }

          // Get pad name
          const padName = pad.name || `Pad ${pad.padIndex + 1}`;
          const originalFileNames: string[] = [];
          let displayFileName = ""; // Store the first filename for display

          // Names only, from the cache warmed in one pass above. This used to
          // read the *whole* audio record — Blob included — per pad-sound slot
          // it had not seen, so the first Ctrl+F of a session on a full board
          // did up to 960 sequential reads before showing a single result.
          try {
            for (const audioId of pad.audioFileIds) {
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
              bankId: pad.bankId,
              pageIndex: bank.pageIndex,
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
                bankNames.get(pad.bankId) ||
                `Bank ${convertIndexToBankNumber(bank.pageIndex)}`,
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
