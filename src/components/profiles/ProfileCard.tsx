"use client";

import { useEffect, useState } from "react";
import { useProfileEdit } from "@/hooks/useProfileEdit";
import { formatDistanceToNow } from "date-fns";
import { useProfileStore } from "@/store/profileStore";
import {
  Profile,
  DEFAULT_BACKUP_REMINDER_PERIOD_MS,
  DEFAULT_NORMALISATION,
} from "@/lib/db";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { useModal } from "@/hooks/modal/useModal";
import { ModalType } from "@/components/modals/modalRegistry";
import { ProfileSyncData } from "@/lib/syncUtils";
import { useServerSync } from "@/hooks/useServerSync";
import { getSyncState } from "@/lib/syncState";
import { useProfileSyncStatus } from "@/store/syncStatusStore";
import { getSyncTimestamp } from "@/lib/googleDrive/utils";
import ProfileSyncPanel from "./sync/ProfileSyncPanel";
import SyncStatusChip from "./sync/SyncStatusChip";

const MS_IN_DAY = 1000 * 60 * 60 * 24;

// Helper to convert period (ms) to days string, handling 'Never' (-1)
function formatReminderPeriod(periodMs: number | undefined): string {
  if (periodMs === -1) {
    return "Disabled";
  }
  if (periodMs === undefined || periodMs <= 0) {
    // Handle undefined or invalid positive values by showing default
    const defaultDays = Math.round(
      DEFAULT_BACKUP_REMINDER_PERIOD_MS / MS_IN_DAY,
    );
    return `${defaultDays} days (Default)`;
  }
  const days = Math.round(periodMs / MS_IN_DAY);
  return `${days} day${days !== 1 ? "s" : ""}`;
}

interface ProfileCardProps {
  profile: Profile;
  isActive: boolean;
}

/**
 * A profile, and a way in to how it syncs.
 *
 * Everything about syncing now lives behind the status chip, in
 * `ProfileSyncPanel`. This card used to carry four conditional sync blocks —
 * one per combination of `syncType` and sign-in state — plus its own status
 * derivation and its own copy of the pause controls, which is how Drive ended
 * up with a manual sync, a pause and a status line while server sync had none
 * of them.
 *
 * What is left is the profile itself: its name, when it was made, and the
 * three things you can do to it. Where it syncs is one click away and no
 * longer competes with them for the reader's attention.
 */
export default function ProfileCard({ profile, isActive }: ProfileCardProps) {
  const { setActiveProfileId, deleteProfile, setNormalisation } =
    useProfileStore();

  const { openProfileEditor } = useProfileEdit();

  const { applyConflictResolution } = useGoogleDriveSync();
  const { resolveConflict: resolveServerConflict } = useServerSync();

  const { openLazyModal, closeModal } = useModal();

  const [isDeleting, setIsDeleting] = useState(false);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);

  // Loudness normalisation. `profile.normalisation` is absent for any profile
  // created before this feature, so every read falls back to the default.
  const normalisation = profile.normalisation ?? DEFAULT_NORMALISATION;

  // Backfill progress for the "Analysing N/M…" indicator. This card only
  // observes — it never calls runBackfill itself. ClientSideInitializer is
  // the pipeline's sole caller; runBackfill's generation-token supersede
  // logic assumes exactly one caller, and a second one here would take a
  // fresh token, supersede the initialiser's run, and could leave the
  // in-memory loudness cache repopulated from a pre-analysis snapshot for
  // any file the surviving run analyses in that window. Gated to the active
  // profile's card because setNormalisation (like setActivePadBehavior,
  // which it is modelled on) always writes to the store's activeProfileId,
  // so a non-active card offering these controls would silently edit the
  // wrong profile.
  const [backfill, setBackfill] = useState({ done: 0, total: 0 });
  useEffect(() => {
    if (!isActive) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void import("@/lib/audio/loudness/pipeline")
      .then(({ subscribeToBackfillProgress }) => {
        if (cancelled) return;
        unsubscribe = subscribeToBackfillProgress(setBackfill);
      })
      .catch((error) => {
        console.warn("[Loudness] Could not observe backfill progress:", error);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isActive]);

  const syncState = getSyncState(profile);
  const syncStatus = useProfileSyncStatus(profile.id);
  const lastSyncedAt =
    syncStatus.lastSyncedAt ??
    (profile.id !== undefined ? getSyncTimestamp(profile.id) || null : null);

  const handleDelete = async () => {
    if (isActive) {
      alert(
        "Cannot delete the active profile. Please switch to another profile first.",
      );
      return;
    }

    try {
      setIsDeleting(true);
      await deleteProfile(profile.id!);
      setIsDeleting(false);
    } catch (error) {
      console.error("Failed to delete profile:", error);
      alert("Failed to delete profile. Please try again.");
      setIsDeleting(false);
    }
  };

  const handleActivate = () => {
    if (!isActive) {
      setActiveProfileId(profile.id!);
    }
  };

  /**
   * Open the resolution modal when a sync of *this* profile hits a conflict,
   * whichever backend it was with.
   *
   * Read from the shared store, keyed by profile, because the sync that finds
   * a conflict is usually not the one this card is holding — the scheduled
   * syncs run in `ClientSideInitializer`'s hook instance and hook state does
   * not cross instances. The card used to work around that by tracking whether
   * it had started the sync itself and only opening the modal then, which
   * meant a conflict found in the background was detected, recorded, and shown
   * to nobody. Server conflicts had nowhere to surface at all: the list of them
   * was computed and never read.
   */
  const { conflicts, conflictData } = syncStatus;

  useEffect(() => {
    if (!conflictData || conflicts.length === 0) return;

    openLazyModal({
      title: "Sync Conflict Resolution",
      modalType: ModalType.CONFLICT_RESOLUTION,
      modalProps: {
        conflicts,
        conflictData,
        onResolve: (resolvedData: ProfileSyncData) => {
          if (conflictData.origin.kind === "drive") {
            applyConflictResolution(
              resolvedData,
              conflictData.origin.fileId,
              profile.id!,
            );
          } else {
            void resolveServerConflict(
              profile.id!,
              resolvedData,
              conflictData.origin,
            );
          }
          closeModal();
        },
        onCancel: () => closeModal(),
      },
      showConfirmButton: false,
      showCancelButton: false,
      size: "xl",
    });
  }, [
    conflictData,
    conflicts,
    openLazyModal,
    closeModal,
    applyConflictResolution,
    resolveServerConflict,
    profile.id,
  ]);

  return (
    <div
      data-testid="profile-card"
      data-profile-name={profile.name}
      className={`border rounded-lg p-4 ${
        isActive
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      }`}
    >
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {profile.name}
          </h3>

          <SyncStatusChip
            state={syncState}
            lastSyncedAt={lastSyncedAt}
            syncing={syncStatus.activity === "syncing"}
            expanded={syncPanelOpen}
            onToggle={() => setSyncPanelOpen((open) => !open)}
          />

          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Created{" "}
            {formatDistanceToNow(new Date(profile.createdAt), {
              addSuffix: true,
            })}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Backup Reminder:{" "}
            {formatReminderPeriod(profile.backupReminderPeriod)}
          </p>
        </div>
        <div className="flex space-x-1">
          {isActive ? (
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              Active
            </span>
          ) : (
            <button
              onClick={handleActivate}
              className="px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
            >
              Use This Profile
            </button>
          )}
        </div>
      </div>

      <div className="flex mt-4 space-x-2">
        <button
          onClick={() => openProfileEditor(profile)}
          className="px-3 py-1 bg-gray-100 text-gray-800 rounded-md text-sm hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          Edit Profile
        </button>
        {!isActive &&
          (isDeleting ? (
            <button
              disabled
              className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm opacity-50 dark:bg-red-900/30 dark:text-red-300"
            >
              Deleting...
            </button>
          ) : (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    `Are you sure you want to delete the profile "${profile.name}"? This cannot be undone.`,
                  )
                ) {
                  handleDelete();
                }
              }}
              className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm hover:bg-red-200 transition-colors dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-800/40"
            >
              Delete
            </button>
          ))}
      </div>

      {syncPanelOpen && <ProfileSyncPanel profile={profile} />}

      {/* Loudness normalisation — active profile only. setNormalisation
          writes to the store's activeProfileId, so these controls would
          silently target the wrong profile if shown on any other card. */}
      {isActive && (
        <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Loudness normalisation
          </h4>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Levels every sound to the same loudness automatically. Your
            per-sound and per-pad gain adjustments are applied on top and are
            never overwritten.
          </p>

          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={normalisation.enabled}
              onChange={(e) =>
                void setNormalisation({
                  ...normalisation,
                  enabled: e.target.checked,
                })
              }
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
              data-testid="normalisation-enabled"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Normalise automatically
            </span>
          </label>

          <label className="mt-3 block">
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Target loudness: {normalisation.targetLufs} LUFS
            </span>
            <input
              type="range"
              min={-30}
              max={-9}
              step={1}
              value={normalisation.targetLufs}
              disabled={!normalisation.enabled}
              onChange={(e) =>
                void setNormalisation({
                  ...normalisation,
                  targetLufs: Number(e.target.value),
                })
              }
              className="mt-1 w-full disabled:opacity-50"
              data-testid="normalisation-target"
            />
          </label>

          {backfill.total > 0 && backfill.done < backfill.total && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Analysing {backfill.done}/{backfill.total}…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
