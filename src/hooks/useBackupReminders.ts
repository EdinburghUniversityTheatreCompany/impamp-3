import { useState, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { Profile, hasProfileChangedSince } from "@/lib/db";

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
    const checkReminders = async () => {
      const now = Date.now();
      const remindersNeeded: Profile[] = [];

      for (const profile of profiles) {
        if (
          profile.backupReminderPeriod === -1 ||
          profile.lastBackedUpAt === undefined ||
          profile.backupReminderPeriod === undefined
        ) {
          continue;
        }

        const timeSinceLastBackup = now - profile.lastBackedUpAt;
        if (timeSinceLastBackup <= profile.backupReminderPeriod) continue;

        // Time is overdue — only remind if something actually changed since last backup
        const contentChanged = await hasProfileChangedSince(
          profile.id!,
          profile.lastBackedUpAt,
        );
        if (!contentChanged) continue;

        remindersNeeded.push(profile);
      }

      setProfilesNeedingReminder((current) => {
        const currentIds = new Set(current.map((p) => p.id));
        if (
          currentIds.size !== remindersNeeded.length ||
          !remindersNeeded.every((p) => currentIds.has(p.id))
        ) {
          return remindersNeeded;
        }
        return current;
      });
    };

    checkReminders();
  }, [profiles]);

  return profilesNeedingReminder;
}
