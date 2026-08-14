"use client";

/**
 * What a profile has got itself into, in words, with what to do about it.
 *
 * Every one of these states was reachable through the old UI and none of them
 * were visible: a profile that said it synced to Drive but had no file there,
 * one still holding server bookkeeping after being pushed onto Drive, one that
 * never reached the server at all. They showed up as syncing silently not
 * happening.
 *
 * The repairs are offered, never applied. Guessing a profile's sync target
 * wrong strands a collaborator's edits, so the choice is the user's — with the
 * exception of borrowed Drive ids, which are provably not this device's and
 * are cleared on load (see `lib/syncReconcile.ts`).
 */

import type { SyncDefect } from "@/lib/syncState";

/** What each defect means, said plainly enough to act on. */
const EXPLANATIONS: Record<SyncDefect, string> = {
  "drive-linked-but-no-file":
    "This profile is set to sync with Google Drive, but there is no file in Drive to sync with. Nothing is being backed up.",
  "stale-server-link":
    "This profile syncs with Google Drive but still has a copy on the ImpAmp server. That copy is no longer being updated, and collaborators are still seeing it.",
  "stale-drive-link":
    "This profile syncs nowhere, but still points at a file in Google Drive. Nothing is being backed up.",
  "server-awaiting-first-sync":
    "This profile has not reached the ImpAmp server yet, so nothing is shared and nothing is backed up.",
  "borrowed-drive-folder":
    "This profile still points at the Google Drive folder of whoever shared it. Sounds you add cannot be published there.",
  "audio-drive-without-folder":
    "Sounds are set to live in Google Drive, but this profile has no Drive folder — so nobody else can hear them.",
  "audio-reaches-nobody":
    "This profile syncs, but its sounds stay on this device — so its pads are silent everywhere else, including your own other devices.",
};

/** Defects the panel can offer to put right in one move. */
const FIXABLE: Partial<Record<SyncDefect, string>> = {
  "audio-reaches-nobody": "Publish the sounds",
  "audio-drive-without-folder": "Publish the sounds",
};

export default function SyncDefectBanner({
  defects,
  onFix,
}: {
  defects: SyncDefect[];
  onFix?: (defect: SyncDefect) => void;
}) {
  if (defects.length === 0) return null;

  return (
    <div
      data-testid="sync-defect-banner"
      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700/60 dark:bg-amber-900/20"
    >
      <ul className="space-y-1">
        {defects.map((defect) => (
          <li
            key={defect}
            data-defect={defect}
            className="text-xs text-amber-800 dark:text-amber-300"
          >
            {EXPLANATIONS[defect]}
            {onFix && FIXABLE[defect] && (
              <button
                type="button"
                onClick={() => onFix(defect)}
                data-testid={`fix-${defect}`}
                className="ml-2 rounded bg-amber-200 px-2 py-0.5 font-medium text-amber-900 transition-colors hover:bg-amber-300 dark:bg-amber-800/50 dark:text-amber-100 dark:hover:bg-amber-700/60"
              >
                {FIXABLE[defect]}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
