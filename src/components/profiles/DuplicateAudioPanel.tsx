"use client";

/**
 * The Maintenance tab's duplicate-audio panel: scan, read, confirm, collapse.
 *
 * `addOrReuseAudioFile` stops new duplicates being written; this is how a user
 * clears out the ones that arrived before it. It is also the only place in the
 * deduplication work that deletes a user's audio, so the panel — not the
 * library underneath it — is where the safety has to read like safety.
 *
 * Three rules it exists to keep:
 *
 *  - **Nothing is deleted on one click.** The scan only reports; the delete
 *    button appears only once there is something to delete, names the count in
 *    its label, and still asks.
 *  - **The report is of what happened, not of what was promised.** The counts
 *    in the preview are from a scan the user may have sat on. A survivor can
 *    be deleted in the gap — a pad cleared, then the orphan sweep pressed,
 *    here or in another tab — and `collapseDuplicateAudioGroups` then skips
 *    that group whole rather than pointing pads at a row that is gone. So the
 *    result line comes from the collapse's own return value, and when it falls
 *    short of the preview the panel says so instead of quietly rounding up.
 *  - **The app must not be left stale.** Pads now name different ids. The
 *    collapse itself re-warms the loudness cache and drops the decoded buffers
 *    it invalidated; the copies of pad data held in React and in the keyboard
 *    listener are this panel's job, and `padConfigsVersion` is the single
 *    counter every one of them re-reads on.
 */

import { useState } from "react";
import { useProfileStore } from "@/store/profileStore";
import { formatBytes } from "@/lib/serverAudio/format";
import { count } from "@/lib/plural";
import type { DuplicateAudioGroup } from "@/lib/audioDedup";

/** How many rows a preview would delete, and how many bytes that gives back. */
function totals(groups: DuplicateAudioGroup[]): {
  copies: number;
  bytes: number;
} {
  return groups.reduce(
    (sum, group) => ({
      copies: sum.copies + group.duplicateIds.length,
      bytes: sum.bytes + group.reclaimableBytes,
    }),
    { copies: 0, bytes: 0 },
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DuplicateAudioPanel() {
  const [isScanning, setIsScanning] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [groups, setGroups] = useState<DuplicateAudioGroup[] | null>(null);
  const [result, setResult] = useState<{
    removedFiles: number;
    reclaimedBytes: number;
    /** What the preview had promised, so a shortfall can be named. */
    previewedCopies: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = isScanning || isCollapsing;

  const handleScan = async () => {
    setIsScanning(true);
    setGroups(null);
    setResult(null);
    setError(null);
    try {
      const { findDuplicateAudioGroups } = await import("@/lib/audioDedup");
      setGroups(await findDuplicateAudioGroups());
    } catch (caught) {
      console.error("Failed to scan for duplicate audio files:", caught);
      setError(`The scan could not finish: ${message(caught)}.`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleCollapse = async () => {
    if (!groups || groups.length === 0) return;
    const { copies } = totals(groups);
    if (
      !window.confirm(
        `Remove ${count(copies, "duplicate audio file", "duplicate audio files")}?\n\n` +
          "This permanently deletes the audio from this browser and cannot be " +
          "undone. Every pad that uses a removed copy will be pointed at the " +
          "copy that stays. A pad that listed both copies is left listing it " +
          "once, so it plays one sound fewer.",
      )
    ) {
      return;
    }

    setIsCollapsing(true);
    setError(null);
    try {
      const { collapseDuplicateAudioGroups } = await import("@/lib/audioDedup");
      // The groups the user just confirmed, not a fresh scan: re-scanning here
      // would act on a set nobody was shown.
      const collapsed = await collapseDuplicateAudioGroups(groups);
      setResult({ ...collapsed, previewedCopies: copies });
      // The preview goes with the press it authorised. Its counts describe a
      // library that no longer exists, and a second press on them would report
      // "removed 0" for work already done.
      setGroups(null);
    } catch (caught) {
      console.error("Failed to remove duplicate audio files:", caught);
      setError(
        `Removing the duplicates failed: ${message(caught)}. ` +
          "Scan again to see what is left.",
      );
    } finally {
      setIsCollapsing(false);
      // Unconditional, and after the error branch as well as the success one.
      // "Nothing was deleted" does not mean "no pad was rewritten": the
      // collapse repoints every pad before it deletes anything, and a throw
      // can land after the transaction has committed. A bump that turns out to
      // have been unnecessary costs one re-read of the current bank.
      useProfileStore.getState().incrementPadConfigsVersion();
    }
  };

  const preview = groups ? totals(groups) : null;

  return (
    <section className="mb-8">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Duplicate Audio Files
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        A sound imported more than once used to be stored more than once: every
        import wrote a fresh copy of the file, even one this browser already
        held. Scanning only looks. Nothing is deleted until you press the button
        the scan offers and confirm.
      </p>

      <div className="space-y-4">
        <div>
          <button
            onClick={handleScan}
            disabled={busy}
            data-testid="duplicate-audio-scan"
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {isScanning ? "Scanning..." : "Scan for Duplicates"}
          </button>
        </div>

        {groups && preview && (
          <div
            className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3 text-sm"
            data-testid="duplicate-audio-preview"
          >
            {groups.length === 0 ? (
              <p className="text-green-600 dark:text-green-400">
                No duplicates found. Every sound in this browser is stored once.
              </p>
            ) : (
              <>
                <p className="text-gray-600 dark:text-gray-300">
                  Found {count(groups.length, "group", "groups")} of identical
                  sounds: {count(preview.copies, "copy", "copies")} to remove,{" "}
                  {formatBytes(preview.bytes)} to reclaim.
                </p>
                {/*
                  Which sounds, not just how many. The totals above are not
                  something a user can check against their own library, and
                  the button below them deletes audio; the names are the only
                  part of the preview anyone can recognise. Every group is
                  listed rather than the first few — the missing-audio list
                  above does the same, and a truncated list would hide exactly
                  the entry someone went looking for.
                */}
                <ul className="space-y-1 text-gray-600 dark:text-gray-300">
                  {groups.map((group) => (
                    <li key={group.hash} data-testid="duplicate-audio-group">
                      <span className="font-medium">
                        {group.names.join(" / ")}
                      </span>{" "}
                      &mdash;{" "}
                      {count(group.duplicateIds.length, "copy", "copies")} to
                      remove, {formatBytes(group.reclaimableBytes)}
                    </li>
                  ))}
                </ul>
                <p className="text-amber-700 dark:text-amber-300">
                  Removing duplicates deletes audio from this browser
                  permanently. There is no undo, and an export you have already
                  taken is the only way back. Your pads keep working: every pad
                  that used a removed copy is pointed at the copy that stays,
                  and keeps its trim and its volume. One case changes what you
                  hear. A pad that listed the same sound twice — once from each
                  copy — is left listing it once, so a pad set to play A, then
                  B, then A again becomes a two-sound pad. If those two entries
                  had different trims or volumes, the ones on the copy that
                  stays are what is kept.
                </p>
                <button
                  onClick={handleCollapse}
                  disabled={busy}
                  data-testid="duplicate-audio-collapse"
                  className="px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  {isCollapsing
                    ? "Removing..."
                    : `Remove ${preview.copies} ${
                        preview.copies === 1 ? "Copy" : "Copies"
                      }`}
                </button>
              </>
            )}
          </div>
        )}

        {result && (
          <div
            role="status"
            data-testid="duplicate-audio-result"
            className="rounded-lg p-4 bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-300 space-y-2"
          >
            <p>
              Removed {count(result.removedFiles, "copy", "copies")} and
              reclaimed {formatBytes(result.reclaimedBytes)}.
            </p>
            {result.removedFiles < result.previewedCopies && (
              <p data-testid="duplicate-audio-shortfall">
                The scan had listed {result.previewedCopies}. The other{" "}
                {result.previewedCopies - result.removedFiles} had already gone
                by the time you confirmed — cleared in another tab, or by the
                orphaned-file cleanup above. Nothing was lost. Scan again to see
                what is left.
              </p>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="duplicate-audio-error"
            className="rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 text-sm text-yellow-800 dark:text-yellow-200"
          >
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
