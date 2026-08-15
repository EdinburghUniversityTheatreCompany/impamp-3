import { useState, useEffect } from "react";
import { useProfileStore } from "@/store/profileStore";
import { Profile, hasProfileChangedSince } from "@/lib/db";
import { getSyncState } from "@/lib/syncState";

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

        // A profile that is healthily syncing somewhere already has a copy
        // elsewhere, kept current without anyone doing anything. Asking for a
        // manual export as well is asking for a chore nobody needs, and a
        // reminder that fires when nothing is wrong is a reminder people learn
        // to dismiss. A paused or defective sync is a different matter — then
        // the copy is *not* current, and the reminder is the only thing that
        // would say so.
        const state = getSyncState(profile);
        if (state.isLinked && !state.paused && state.defects.length === 0) {
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
