"use client";

/**
 * The Maintenance tab's missing-audio panel: scan, then repair one pad at a
 * time.
 *
 * A pad names its sounds by id, and the ids outlive the rows: a library
 * restored without its audio, a profile connected from Drive whose downloads
 * failed, a browser that evicted its storage. The pad still looks assigned and
 * plays nothing. This finds every such reference and lets a file be supplied
 * for each one.
 *
 * Two keys, because two different things are being identified.
 *
 * A repair acts on a *reference*: one pad's mention of one absent audio row,
 * `profile-bank-pad-missingId`. Not the missing id alone — one absent row is
 * routinely named by several pads, and keying the "replacing" and "replaced"
 * sets on the id would mark all of them done the moment one was repaired.
 *
 * A *row* is one line on screen, and a pad can hold the same id twice (add the
 * same bytes again and `addOrReuseAudioFile` returns the row already there),
 * so `findMissingAudioFiles` reports one reference once per occurrence. The
 * reference key is the same string for both, which left the two rows sharing a
 * React key and a `data-testid` — the collision `EditPadForm` mints its
 * `rowId` of `${fileId}-${occurrence}` for, and the same answer is used here.
 *
 * The state stays on the reference deliberately, and that is not the bug
 * repeating itself: `replaceMissingAudioFile` swaps *every* occurrence of the
 * id in the pad, so one file really does repair both rows, and marking one
 * "Replaced" while the other still offered a picker would be the lie in the
 * other direction. Identity on screen, state underneath.
 *
 * Replacement goes through `replaceMissingAudioFile`, which reuses an audio
 * row already holding the same bytes rather than writing a second copy —
 * re-linking a sound the library still has under another pad is the ordinary
 * case, not the exception.
 */

import { useState } from "react";
import { MissingAudioFile } from "@/lib/db";
import { errorMessage } from "@/lib/errorMessage";
import { useProfileStore } from "@/store/profileStore";
import SpinnerIcon from "@/components/icons/SpinnerIcon";

/**
 * What one repair acts on: a pad's mention of one absent audio row.
 *
 * Written once because the places that need it — the replace handler and the
 * rows it re-renders — have to agree exactly, and the same rule written twice
 * is this repo's characteristic regression.
 */
function referenceKeyOf(entry: MissingAudioFile): string {
  return `${entry.profileId}-${entry.bankId}-${entry.padIndex}-${entry.missingAudioFileId}`;
}

/** One line on screen: a reference, and which occurrence of it this is. */
interface MissingAudioRow {
  entry: MissingAudioFile;
  /** Unique across the whole list — the React key and every `data-testid`. */
  rowKey: string;
  /** Shared by every occurrence of one reference — all of the panel's state. */
  referenceKey: string;
}

/** Numbers each reference's occurrences, in the order the scan reported them. */
function rowsOf(entries: MissingAudioFile[]): MissingAudioRow[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const referenceKey = referenceKeyOf(entry);
    const occurrence = seen.get(referenceKey) ?? 0;
    seen.set(referenceKey, occurrence + 1);
    return { entry, referenceKey, rowKey: `${referenceKey}-${occurrence}` };
  });
}

export default function MissingAudioPanel() {
  // Missing audio files state
  const [isScanningMissing, setIsScanningMissing] = useState(false);
  const [missingScanResult, setMissingScanResult] = useState<
    MissingAudioFile[] | null
  >(null);
  const [replacingIds, setReplacingIds] = useState<Set<string>>(new Set());
  const [replacedIds, setReplacedIds] = useState<Set<string>>(new Set());
  const [scanError, setScanError] = useState<string | null>(null);

  // Numbered per render rather than stored: the scan result is the only input,
  // so a second copy in state is a second thing to keep in step with it.
  const rows = rowsOf(missingScanResult ?? []);

  const handleScanMissing = async () => {
    setIsScanningMissing(true);
    setMissingScanResult(null);
    setReplacingIds(new Set());
    setReplacedIds(new Set());
    setScanError(null);
    try {
      const { findMissingAudioFiles } = await import("@/lib/db");
      const result = await findMissingAudioFiles();
      setMissingScanResult(result);
    } catch (error) {
      console.error("Failed to scan for missing audio files:", error);
      // On screen, not only in the console. Nothing appearing is exactly what
      // a library with no missing references looks like, so a swallowed
      // failure reads as "your board is fine" to the one user whose board is
      // not.
      setScanError(`The scan could not finish: ${errorMessage(error)}.`);
    } finally {
      setIsScanningMissing(false);
    }
  };

  const handleReplaceMissingFile = async (
    entry: MissingAudioFile,
    file: File,
  ) => {
    const key = referenceKeyOf(entry);
    setReplacingIds((prev) => new Set(prev).add(key));
    try {
      const { replaceMissingAudioFile } = await import("@/lib/db");
      await replaceMissingAudioFile(
        entry.profileId,
        entry.bankId,
        entry.padIndex,
        entry.missingAudioFileId,
        file,
      );
      setReplacedIds((prev) => new Set(prev).add(key));
    } catch (error) {
      console.error("Failed to replace missing audio file:", error);
    } finally {
      setReplacingIds((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      // The pad now names a different row, and every in-memory copy of it —
      // the grid, the keyboard listener's map of what each key plays — still
      // holds the id that is not there. `padConfigsVersion` is the single
      // counter all of them re-read on, so without this the sound is repaired
      // and the pad stays silent until a bank switch or a reload.
      //
      // Unconditional, as in `DuplicateAudioPanel`: a throw can land after the
      // pad transaction committed, and a bump that turns out to have been
      // unnecessary costs one re-read of the current bank.
      useProfileStore.getState().incrementPadConfigsVersion();
    }
  };

  return (
    <section className="mb-8">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Missing Audio Files
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Scan for pads that reference audio files no longer stored in this
        browser. You can supply a replacement file for each missing reference.
      </p>

      <div className="space-y-4">
        <div>
          <button
            onClick={handleScanMissing}
            disabled={isScanningMissing}
            data-testid="missing-audio-scan"
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {isScanningMissing ? (
              <>
                <SpinnerIcon className="-ml-1 mr-3 h-5 w-5 text-white inline" />
                Scanning...
              </>
            ) : (
              "Scan for Missing Audio Files"
            )}
          </button>
        </div>

        {scanError && (
          <div
            role="alert"
            data-testid="missing-audio-scan-error"
            className="rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 text-sm text-yellow-800 dark:text-yellow-200"
          >
            {scanError}
          </div>
        )}

        {missingScanResult !== null && (
          <div
            className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4"
            data-testid="missing-audio-result"
          >
            {missingScanResult.length === 0 ? (
              <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                No missing audio files found.
              </p>
            ) : (
              <>
                <p className="text-sm text-orange-600 dark:text-orange-400 font-medium mb-4">
                  {missingScanResult.length} missing audio file
                  {missingScanResult.length !== 1 ? "s" : ""} found
                </p>
                {Array.from(
                  new Map(
                    missingScanResult.map((e) => [e.profileId, e.profileName]),
                  ).entries(),
                ).map(([profileId, profileName]) => (
                  <div key={profileId} className="mb-4 last:mb-0">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      {profileName}
                    </p>
                    <div className="space-y-2">
                      {rows
                        .filter(({ entry }) => entry.profileId === profileId)
                        .map(({ entry, rowKey, referenceKey }) => {
                          const isReplacing = replacingIds.has(referenceKey);
                          const isReplaced = replacedIds.has(referenceKey);
                          return (
                            <div
                              key={rowKey}
                              data-testid="missing-audio-row"
                              className="flex items-center justify-between gap-4 text-sm bg-white dark:bg-gray-700 rounded px-3 py-2"
                            >
                              <span className="text-gray-700 dark:text-gray-200">
                                {/*
                                  The name alone, with no "Bank " in front of
                                  it: `bankName` is the bank's *stored* name,
                                  and a bank nobody renamed is stored as
                                  "Bank 6" — so a prefix here reads
                                  "Bank Bank 6" on every default bank and only
                                  looks right on the renamed ones. The search
                                  results render a bank name the same way.
                                */}
                                {entry.bankName} &rsaquo;{" "}
                                {entry.padName
                                  ? `"${entry.padName}"`
                                  : `Pad ${entry.padIndex + 1}`}
                              </span>
                              {isReplaced ? (
                                <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">
                                  Replaced
                                </span>
                              ) : (
                                <label className="shrink-0">
                                  <input
                                    type="file"
                                    accept="audio/*"
                                    className="sr-only"
                                    data-testid={`missing-audio-replace-${rowKey}`}
                                    disabled={isReplacing}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file)
                                        handleReplaceMissingFile(entry, file);
                                    }}
                                  />
                                  <span
                                    className={`cursor-pointer px-3 py-1 text-xs rounded border transition-colors ${
                                      isReplacing
                                        ? "border-gray-300 text-gray-400 cursor-not-allowed"
                                        : "border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                    }`}
                                  >
                                    {isReplacing
                                      ? "Replacing…"
                                      : "Choose replacement…"}
                                  </span>
                                </label>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
