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
 * The row identity is the whole of the state here, and it is
 * `profile-bank-pad-missingId` rather than the missing id alone: one absent
 * audio row is routinely named by several pads, and keying the "replacing" and
 * "replaced" sets on the id would mark all of them done the moment one was
 * repaired. That is the same collision `EditPadForm` mints its `rowId` for.
 *
 * Replacement goes through `replaceMissingAudioFile`, which reuses an audio
 * row already holding the same bytes rather than writing a second copy —
 * re-linking a sound the library still has under another pad is the ordinary
 * case, not the exception.
 */

import { useState } from "react";
import { MissingAudioFile } from "@/lib/db";
import { useProfileStore } from "@/store/profileStore";
import { SpinnerIcon } from "@/components/icons";

/**
 * What the panel's per-row state is keyed on.
 *
 * Written once because the two places that need it — the replace handler and
 * the row it re-renders — have to agree exactly, and the same rule written
 * twice is this repo's characteristic regression.
 */
function rowKeyOf(entry: MissingAudioFile): string {
  return `${entry.profileId}-${entry.bankId}-${entry.padIndex}-${entry.missingAudioFileId}`;
}

export default function MissingAudioPanel() {
  // Missing audio files state
  const [isScanningMissing, setIsScanningMissing] = useState(false);
  const [missingScanResult, setMissingScanResult] = useState<
    MissingAudioFile[] | null
  >(null);
  const [replacingIds, setReplacingIds] = useState<Set<string>>(new Set());
  const [replacedIds, setReplacedIds] = useState<Set<string>>(new Set());

  const handleScanMissing = async () => {
    setIsScanningMissing(true);
    setMissingScanResult(null);
    setReplacingIds(new Set());
    setReplacedIds(new Set());
    try {
      const { findMissingAudioFiles } = await import("@/lib/db");
      const result = await findMissingAudioFiles();
      setMissingScanResult(result);
    } catch (error) {
      console.error("Failed to scan for missing audio files:", error);
    } finally {
      setIsScanningMissing(false);
    }
  };

  const handleReplaceMissingFile = async (
    entry: MissingAudioFile,
    file: File,
  ) => {
    const key = rowKeyOf(entry);
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
                      {missingScanResult
                        .filter((e) => e.profileId === profileId)
                        .map((entry) => {
                          const key = rowKeyOf(entry);
                          const isReplacing = replacingIds.has(key);
                          const isReplaced = replacedIds.has(key);
                          return (
                            <div
                              key={key}
                              data-testid="missing-audio-row"
                              className="flex items-center justify-between gap-4 text-sm bg-white dark:bg-gray-700 rounded px-3 py-2"
                            >
                              <span className="text-gray-700 dark:text-gray-200">
                                Bank {entry.bankName} &rsaquo;{" "}
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
                                    data-testid={`missing-audio-replace-${key}`}
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
