"use client";

import { useState, ChangeEvent, useEffect } from "react"; // Corrected imports
import { useProfileStore } from "@/store/profileStore";
import { Profile, SyncType, DEFAULT_BACKUP_REMINDER_PERIOD_MS } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";

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

export default function ProfileCard({ profile, isActive }: ProfileCardProps) {
  const { setActiveProfileId, updateProfile, deleteProfile } =
    useProfileStore();
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [syncType, setSyncType] = useState<SyncType>(profile.syncType);
  const [isDeleting, setIsDeleting] = useState(false);

  // State for the reminder input (days as string) and checkbox
  const [reminderDays, setReminderDays] = useState<string>(() => {
    const period = profile.backupReminderPeriod;
    if (period === -1 || period === undefined || period <= 0) {
      return Math.round(
        DEFAULT_BACKUP_REMINDER_PERIOD_MS / MS_IN_DAY,
      ).toString(); // Default days if disabled/invalid
    }
    return Math.round(period / MS_IN_DAY).toString();
  });
  const [isReminderDisabled, setIsReminderDisabled] = useState<boolean>(
    profile.backupReminderPeriod === -1,
  );

  // Effect to reset state if the profile prop changes (e.g., after save)
  useEffect(() => {
    setName(profile.name);
    setSyncType(profile.syncType);
    const period = profile.backupReminderPeriod;
    setIsReminderDisabled(period === -1);
    if (period === -1 || period === undefined || period <= 0) {
      setReminderDays(
        Math.round(DEFAULT_BACKUP_REMINDER_PERIOD_MS / MS_IN_DAY).toString(),
      );
    } else {
      setReminderDays(Math.round(period / MS_IN_DAY).toString());
    }
  }, [profile]);

  const handleSave = async () => {
    // Validate name
    if (!name.trim()) {
      alert("Profile name cannot be empty.");
      return;
    }
    let calculatedPeriodMs: number;
    if (isReminderDisabled) {
      calculatedPeriodMs = -1; // -1 means disabled
    } else {
      const days = parseInt(reminderDays, 10);
      if (isNaN(days) || days <= 0) {
        alert(
          "Please enter a valid positive number of days for the reminder period.",
        );
        return;
      }
      calculatedPeriodMs = days * MS_IN_DAY;
    }

    try {
      await updateProfile(profile.id!, {
        name: name.trim(),
        syncType,
        backupReminderPeriod: calculatedPeriodMs, // Save calculated value
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update profile:", error);
      alert("Failed to update profile. Please try again.");
    }
  };

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

  return (
    <div
      className={`border rounded-lg p-4 ${
        isActive
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      }`}
    >
      {isEditing ? (
        // Edit mode
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Profile Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
              placeholder="Profile Name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Sync Type
            </label>
            <select
              value={syncType}
              onChange={(e) => setSyncType(e.target.value as SyncType)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="local">Local Only</option>
              <option value="googleDrive">Google Drive</option>
            </select>
            {syncType === "googleDrive" && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Google Drive integration will be available in a future update.
              </p>
            )}
          </div>

          {/* Backup Reminder Period Input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Remind After (Days)
            </label>
            <div className="flex items-center space-x-2">
              <input
                id={`backupReminderDays-${profile.id}`}
                type="number"
                min="1" // Ensure positive number
                value={reminderDays}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setReminderDays(e.target.value)
                }
                disabled={isReminderDisabled}
                className={`w-20 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100 ${isReminderDisabled ? "opacity-50 bg-gray-100 dark:bg-gray-600" : ""}`}
                placeholder="e.g., 30"
              />
              <div className="flex items-center">
                <input
                  id={`backupReminderDisable-${profile.id}`}
                  type="checkbox"
                  checked={isReminderDisabled}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setIsReminderDisabled(e.target.checked)
                  }
                  className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                />
                <label
                  htmlFor={`backupReminderDisable-${profile.id}`}
                  className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
                >
                  Disable Reminder
                </label>
              </div>
            </div>
          </div>

          <div className="flex space-x-2 pt-2">
            <button
              onClick={handleSave}
              className="px-3 py-1 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600 transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => {
                // Reset state on cancel - using new state vars
                setName(profile.name);
                setSyncType(profile.syncType);
                const period = profile.backupReminderPeriod;
                setIsReminderDisabled(period === -1);
                if (period === -1 || period === undefined || period <= 0) {
                  setReminderDays(
                    Math.round(
                      DEFAULT_BACKUP_REMINDER_PERIOD_MS / MS_IN_DAY,
                    ).toString(),
                  );
                } else {
                  setReminderDays(Math.round(period / MS_IN_DAY).toString());
                }
                setIsEditing(false);
              }}
              className="px-3 py-1 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-md text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        // View mode
        <>
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {profile.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {profile.syncType === "googleDrive"
                  ? "Google Drive Sync"
                  : "Local Storage Only"}
              </p>
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
                  Activate
                </button>
              )}
            </div>
          </div>

          <div className="flex mt-4 space-x-2">
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-1 bg-gray-100 text-gray-800 rounded-md text-sm hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Edit
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
        </>
      )}
    </div>
  );
}
