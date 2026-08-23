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
  extractPadPlaybackSettings,
  type PadPlaybackSettings,
} from "@/lib/db";
import { getAllPadConfigurationsForProfile } from "@/lib/importExport";
import { convertIndexToBankNumber } from "@/lib/bankUtils";

/**
 * Search result item representing a match.
 *
 * The playback half is `PadPlaybackSettings` rather than a restatement of its
 * members. This was a hand-built projection that named eight pad fields, and
 * the modal then rebuilt a trigger payload and an armed cue out of it by hand
 * again — three literals, none of which the compiler tied to the others, so a
 * pad field could go missing at any of the three without a word.
 */
export interface SearchResult extends PadPlaybackSettings {
  /** Profile ID the result belongs to */
  profileId: number;
  /** Identity of the bank containing the result, used to play the pad */
  bankId: string;
  /** Position of the bank containing the result, used to navigate to it */
  pageIndex: number;
  /** Pad index within the page */
  padIndex: number;
  /** Pad display name — a numbered fallback where the pad has no name */
  name: string;
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

/** A finished search: what it found, and the question it answers. */
interface CompletedSearch {
  term: string;
  profileId: number | null;
  results: SearchResult[];
  /**
   * Why this term found nothing, when it *failed* rather than matched nothing.
   *
   * Stored beside the term for the same reason the results are: a render that
   * saw the failure without the term it belongs to could show it against the
   * next query.
   */
  error: string | null;
}

export function useSearch(searchOptions: SearchOptions = {}) {
  const { debounceTime = 300 } = searchOptions;

  // State
  const [searchTerm, setSearchTerm] = useState("");
  // The results and the question they answer, stored together so no render
  // can ever see one without the other. Kept as one object rather than two
  // pieces of state for that reason: a caller deciding whether to fire a cue
  // reads both, and a render where the results had updated and the term had
  // not would be exactly the wrong moment to ask.
  const [completed, setCompleted] = useState<CompletedSearch>({
    term: "",
    profileId: null,
    results: NO_RESULTS,
    error: null,
  });
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
              ...extractPadPlaybackSettings(pad),
              profileId: activeProfileId,
              bankId: pad.bankId,
              pageIndex: bank.pageIndex,
              padIndex: pad.padIndex,
              // After the spread: an unnamed pad is listed by its number, and
              // `extractPadPlaybackSettings` would leave the name undefined.
              name: padName,
              originalFileName: displayFileName,
              bankName:
                bankNames.get(pad.bankId) ||
                `Bank ${convertIndexToBankNumber(bank.pageIndex)}`,
            });
          }
        }

        if (!cancelled) {
          setCompleted({
            term: searchTerm,
            profileId: activeProfileId,
            results: searchResults,
            error: null,
          });
        }
      } catch (error) {
        console.error("Error searching pads:", error);
        // A search that threw has still *answered* this term, and has to say
        // so. Leaving `completed` on the previous term left `isStale` true for
        // this one forever, with `isLoading` false throughout: the modal shows
        // a "Searching…" that never resolves, and refuses Enter with "these
        // results are for <the previous term>" for a search that will never
        // finish. Recording the failure against the term is what ends both,
        // and the message is what puts the failure on screen instead of only
        // in the console.
        if (!cancelled) {
          setCompleted({
            term: searchTerm,
            profileId: activeProfileId,
            results: NO_RESULTS,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

  // Whether what is on screen answers a question nobody is asking any more.
  // Only ever true while something *is* on screen: an empty box shows nothing,
  // so there is nothing for a caller to mistake for an answer.
  const isStale =
    hasQuery &&
    (completed.term !== searchTerm || completed.profileId !== activeProfileId);

  return {
    searchTerm,
    setSearchTerm,
    results: hasQuery ? completed.results : NO_RESULTS,
    isLoading: hasQuery && isLoading,
    /**
     * True while the visible results were computed for a different term, or
     * for a different profile.
     *
     * The debounce is 300 ms and `isLoading` stays false for all of it, so
     * without this a caller acting on `results[0]` — the search modal's Enter
     * key does exactly that — acts on the previous query. Blanking the list
     * instead would be worse: the results are still worth reading while the
     * next ones are computed, and a list that empties on every keystroke is
     * unusable. So they stay, and this says what they are.
     */
    isStale,
    /** The term the visible results were computed for, so a caller can say so. */
    resultsTerm: completed.term,
    /**
     * Why the current term found nothing, when the search failed outright.
     *
     * Gated on `hasQuery` alongside `results` and `isStale`, so emptying the
     * box hides the failure with everything else it belongs to.
     */
    error: hasQuery ? completed.error : null,

    // Helper method to clear the search
    clearSearch: () => setSearchTerm(""),
  };
}
