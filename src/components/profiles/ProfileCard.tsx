"use client";

import { useEffect, useState } from "react";
import { useProfileEdit } from "@/hooks/useProfileEdit";
import { formatDistanceToNow } from "date-fns";
import { useProfileStore } from "@/store/profileStore";
import { Profile, DEFAULT_BACKUP_REMINDER_PERIOD_MS } from "@/lib/db";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { useModal } from "@/hooks/modal/useModal";
import { ModalType } from "@/components/modals/modalRegistry";
import { ProfileSyncData } from "@/lib/syncUtils";
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
  const { setActiveProfileId, deleteProfile } = useProfileStore();

  const { openProfileEditor } = useProfileEdit();

  const {
    syncStatus: driveHookStatus,
    conflicts: driveHookConflicts,
    conflictData: driveHookConflictData,
    applyConflictResolution,
  } = useGoogleDriveSync();

  const { openLazyModal, closeModal } = useModal();

  const [isDeleting, setIsDeleting] = useState(false);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);

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

  // Open conflict resolution when a Drive sync of *this* profile finds
  // conflicts.
  //
  // Matched on the Drive file id, which identifies the profile. The card used
  // to track whether it had started the sync itself and only open the modal
  // then — the conflict data carries no profile id, so that was the only
  // handle available. It meant a conflict found by a background sync had
  // nowhere to surface, and the profile just stopped converging.
  useEffect(() => {
    if (
      driveHookStatus !== "conflict" ||
      !driveHookConflictData ||
      driveHookConflicts.length === 0 ||
      !profile.googleDriveFileId ||
      driveHookConflictData.fileId !== profile.googleDriveFileId
    ) {
      return;
    }

    openLazyModal({
      title: "Sync Conflict Resolution",
      modalType: ModalType.CONFLICT_RESOLUTION,
      modalProps: {
        conflicts: driveHookConflicts,
        conflictData: driveHookConflictData,
        onResolve: (resolvedData: ProfileSyncData) => {
          applyConflictResolution(
            resolvedData,
            driveHookConflictData.fileId,
            profile.id!,
          );
          closeModal();
        },
        onCancel: () => closeModal(),
      },
      showConfirmButton: false,
      showCancelButton: false,
      size: "xl",
    });
  }, [
    driveHookStatus,
    driveHookConflictData,
    driveHookConflicts,
    openLazyModal,
    closeModal,
    applyConflictResolution,
    profile.id,
    profile.googleDriveFileId,
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
    </div>
  );
}
