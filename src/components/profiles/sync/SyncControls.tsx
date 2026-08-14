"use client";

/**
 * Sync now, and pause syncing — for both backends.
 *
 * Drive had all of this and server sync had none of it: no manual sync, no
 * pause, no status, no way to tell whether anything was happening. Not because
 * server sync could not be paused — `serverSync/sync.ts` has honoured
 * `syncPausedUntil` from the start, and the pause helpers in `profileStore`
 * never cared which backend a profile used — but because the controls were
 * written inside a block gated on `profile.googleDriveFileId`.
 */

import { useState } from "react";
import { format } from "date-fns";
import type { SyncState } from "@/lib/syncState";
import type { ProfileSyncStatus } from "@/store/syncStatusStore";

const PAUSE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: "2 hours", ms: 2 * 60 * 60 * 1000 },
  { label: "4 hours", ms: 4 * 60 * 60 * 1000 },
  { label: "8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
];

/** The pause with no end. Far enough out to be indefinite, still a number. */
const INDEFINITE_MS = Number.MAX_SAFE_INTEGER - Date.now();

interface SyncControlsProps {
  state: SyncState;
  status: ProfileSyncStatus;
  onSyncNow: () => Promise<void>;
  onPause: (durationMs: number) => Promise<void>;
  onResume: () => Promise<void>;
}

export default function SyncControls({
  state,
  status,
  onSyncNow,
  onPause,
  onResume,
}: SyncControlsProps) {
  const [busy, setBusy] = useState(false);
  const [showPauseOptions, setShowPauseOptions] = useState(false);

  if (state.target === "local") return null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const syncing = status.activity === "syncing";

  return (
    <div className="space-y-2" data-testid="sync-controls">
      {state.paused && (
        <div className="rounded-md bg-purple-50 px-3 py-2 dark:bg-purple-900/20">
          <p className="text-xs font-medium text-purple-700 dark:text-purple-300">
            {state.pausedUntil &&
            state.pausedUntil < Number.MAX_SAFE_INTEGER / 2
              ? `Syncing is paused until ${format(new Date(state.pausedUntil), "h:mm a, MMM d")}.`
              : "Syncing is paused until you turn it back on."}
          </p>
          <button
            type="button"
            onClick={() => run(onResume)}
            disabled={busy}
            data-testid="sync-resume"
            className="mt-1 rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800 transition-colors hover:bg-purple-200 disabled:opacity-50 dark:bg-purple-800/30 dark:text-purple-300 dark:hover:bg-purple-700/40"
          >
            Resume now
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => run(onSyncNow)}
          disabled={busy || syncing || state.paused || !state.isLinked}
          data-testid="sync-now"
          title={
            !state.isLinked
              ? "This profile has not reached its backend yet."
              : state.paused
                ? "Syncing is paused."
                : undefined
          }
          className="rounded-md bg-blue-100 px-3 py-1 text-xs text-blue-800 transition-colors hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
        >
          {syncing
            ? "Syncing…"
            : state.readOnly
              ? "Check for changes"
              : "Sync now"}
        </button>

        {!state.paused && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowPauseOptions((open) => !open)}
              aria-expanded={showPauseOptions}
              data-testid="sync-pause"
              className="rounded-md bg-purple-100 px-3 py-1 text-xs text-purple-800 transition-colors hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:hover:bg-purple-800/40"
            >
              Pause syncing
            </button>

            {showPauseOptions && (
              <div className="absolute z-10 mt-1 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800">
                {PAUSE_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => {
                      setShowPauseOptions(false);
                      void run(() => onPause(option.ms));
                    }}
                    className="block w-full px-3 py-1 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    For {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setShowPauseOptions(false);
                    void run(() => onPause(INDEFINITE_MS));
                  }}
                  className="block w-full px-3 py-1 text-left text-xs text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Until I turn it back on
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {status.error && (
        <p
          data-testid="sync-error"
          className="text-xs text-red-600 dark:text-red-400"
        >
          {status.error}
        </p>
      )}

      {/*
        Warnings are not errors. A sync that finished with warnings used to
        report them through the error channel, so a partial success looked like
        a failure.
      */}
      {status.warnings.length > 0 && (
        <ul
          data-testid="sync-warnings"
          className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400"
        >
          {status.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
