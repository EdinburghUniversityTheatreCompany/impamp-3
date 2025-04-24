import { useState, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { Profile } from "@/lib/db";

/**
 * Hook to identify profiles that require a backup reminder.
 *
 * @returns An array of profiles that are due for a backup reminder.
 */
export function useBackupReminders(): Profile[] {
  const profiles = useProfileStore((state) => state.profiles);
  const [profilesNeedingReminder, setProfilesNeedingReminder] = useState<
    Profile[]
  >([]);

  useEffect(() => {
    console.log(
      "[useBackupReminders] Checking profiles for backup reminders...",
    );
    const now = Date.now();
    const remindersNeeded: Profile[] = [];

    profiles.forEach((profile) => {
      // Skip if reminder period is set to 'never' (-1) or if essential data is missing
      if (
        profile.backupReminderPeriod === -1 ||
        profile.lastBackedUpAt === undefined ||
        profile.backupReminderPeriod === undefined
      ) {
        return;
      }

      const timeSinceLastBackup = now - profile.lastBackedUpAt;
      const reminderPeriod = profile.backupReminderPeriod;

      console.log(
        `[useBackupReminders] Profile: ${profile.name} (ID: ${profile.id}), Last Backup: ${new Date(profile.lastBackedUpAt).toISOString()}, Reminder Period (ms): ${reminderPeriod}, Time Since Last Backup (ms): ${timeSinceLastBackup}`,
      );

      if (timeSinceLastBackup > reminderPeriod) {
        console.log(
          `[useBackupReminders] Reminder needed for profile: ${profile.name} (ID: ${profile.id})`,
        );
        remindersNeeded.push(profile);
      }
    });

    // Only update state if the list of profiles needing reminders has actually changed
    // This prevents unnecessary re-renders if the list remains the same
    setProfilesNeedingReminder((currentReminders) => {
      const currentIds = new Set(currentReminders.map((p) => p.id));
      const newIds = new Set(remindersNeeded.map((p) => p.id));

      if (
        currentIds.size !== newIds.size ||
        !remindersNeeded.every((p) => currentIds.has(p.id))
      ) {
        console.log(
          "[useBackupReminders] Updating state with profiles needing reminders:",
          remindersNeeded.map((p) => p.name),
        );
        return remindersNeeded;
      }
      console.log(
        "[useBackupReminders] No change in profiles needing reminders.",
      );
      return currentReminders; // Return the existing state if no change
    });
  }, [profiles]); // Re-run the effect when the profiles list changes

  return profilesNeedingReminder;
}
