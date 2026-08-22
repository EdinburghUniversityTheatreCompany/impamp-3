"use client";

/**
 * The one line on a profile card that answers "where does this sync, and is it
 * working?".
 *
 * There was no such line. A card showed "Google Drive Sync" or "Local Storage
 * Only" — and "Local Storage Only" for server-synced profiles too, in the
 * switcher — plus a status that only appeared for syncs you had started
 * yourself from that very card. Everything else about the profile's state was
 * either invisible or spread across four conditional blocks further down.
 */

import { formatDistanceToNow } from "date-fns";
import { syncChipText, type SyncState } from "@/lib/syncState";
import { ChevronDownIcon } from "@/components/icons";

interface SyncStatusChipProps {
  state: SyncState;
  lastSyncedAt: number | null;
  syncing: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Amber when something needs a decision, plain otherwise. Deliberately only
 * two colours: a chip that goes green on every successful sync trains people
 * to ignore its colour, which is the one thing it needs them not to do.
 */
function toneFor(state: SyncState): string {
  if (state.defects.length > 0) {
    return "text-amber-700 dark:text-amber-400";
  }
  return "text-gray-500 dark:text-gray-400";
}

export default function SyncStatusChip({
  state,
  lastSyncedAt,
  syncing,
  expanded,
  onToggle,
}: SyncStatusChipProps) {
  const relative =
    lastSyncedAt !== null
      ? formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })
      : null;

  const text = syncing
    ? `${syncChipText(state, null)} · syncing…`
    : syncChipText(state, relative);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="sync-status-chip"
      className={`mt-1 flex items-center gap-1 text-xs hover:underline ${toneFor(state)}`}
    >
      <span>{text}</span>
      <ChevronDownIcon
        className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
      />
      <span className="sr-only">
        {expanded ? "Hide sync settings" : "Show sync settings"}
      </span>
    </button>
  );
}
