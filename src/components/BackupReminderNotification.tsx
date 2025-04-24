"use client";

import React from "react";
import { useBackupReminders } from "@/hooks/useBackupReminders";
import { useProfileStore } from "@/store/profileStore";

/**
 * Displays a notification banner if any profiles are due for a backup reminder.
 */
export default function BackupReminderNotification() {
  const profilesNeedingReminder = useBackupReminders();
  const openProfileManager = useProfileStore(
    (state) => state.openProfileManager,
  );

  if (profilesNeedingReminder.length === 0) {
    return null; // Don't render anything if no reminders are needed
  }

  const profileNames = profilesNeedingReminder.map((p) => p.name).join(", ");

  return (
    <div
      data-testid="backup-reminder-banner" // Added data-testid
      className="fixed top-4 left-1/2 transform -translate-x-1/2 z-40 w-auto max-w-md p-4 bg-yellow-100 dark:bg-yellow-900 border border-yellow-300 dark:border-yellow-700 rounded-md shadow-lg flex items-center space-x-4" // Changed z-50 to z-40
      role="alert"
    >
      <svg
        className="h-6 w-6 text-yellow-600 dark:text-yellow-400 flex-shrink-0"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <div className="flex-grow">
        <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
          Backup Recommended
        </p>
        <p className="text-sm text-yellow-700 dark:text-yellow-300">
          Consider backing up the following profile(s): {profileNames}
        </p>
      </div>
      <button
        onClick={openProfileManager}
        className="ml-auto px-3 py-1.5 text-sm font-medium text-yellow-800 dark:text-yellow-200 bg-yellow-200 dark:bg-yellow-800 hover:bg-yellow-300 dark:hover:bg-yellow-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-yellow-100 dark:focus:ring-offset-yellow-900 focus:ring-yellow-500"
      >
        Manage Profiles
      </button>
    </div>
  );
}
