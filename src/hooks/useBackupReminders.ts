import { useState, useEffect, useMemo } from "react";
import { useProfileStore } from "@/store/profileStore";
import { Profile, hasProfileChangedSince } from "@/lib/db";
import { getSyncState } from "@/lib/syncState";

/**
 * Whether a profile could possibly need a reminder, before asking the database.
 *
 * Exported because it decides two things that must agree: which profiles the
 * sweep below walks, and which fields a change in `profiles` has to touch
 * before the sweep is worth running again. Written twice, those two would
 * drift, and the drifted copy would be the one deciding when to re-read.
 *
 * @param profile - The profile to judge
 * @returns True if it is worth asking the database about this one
 */
export function couldNeedReminder(profile: Profile): boolean {
  if (
    profile.backupReminderPeriod === -1 ||
    profile.lastBackedUpAt === undefined ||
    profile.backupReminderPeriod === undefined
  ) {
    return false;
  }

  // A profile that is healthily syncing somewhere already has a copy
  // elsewhere, kept current without anyone doing anything. Asking for a
  // manual export as well is asking for a chore nobody needs, and a
  // reminder that fires when nothing is wrong is a reminder people learn
  // to dismiss. A paused or defective sync is a different matter — then
  // the copy is *not* current, and the reminder is the only thing that
  // would say so.
  const state = getSyncState(profile);
  return !(state.isLinked && !state.paused && state.defects.length === 0);
}

/**
 * Which of these profiles are overdue for a backup *and* have changed since.
 *
 * The expensive half: `hasProfileChangedSince` is two full
 * `index("profileId").getAll()` scans, so it is asked only about profiles
 * whose reminder period has already elapsed.
 *
 * @param candidates - Profiles that passed `couldNeedReminder`
 * @param now - The current time, injected so the rule is testable
 * @returns The ids needing a reminder, in the order given
 */
export async function sweepForReminders(
  candidates: Profile[],
  now: number,
): Promise<number[]> {
  const needed: number[] = [];

  for (const profile of candidates) {
    const lastBackedUpAt = profile.lastBackedUpAt!;
    if (now - lastBackedUpAt <= profile.backupReminderPeriod!) continue;

    // Overdue — but only worth saying if something actually changed since.
    if (!(await hasProfileChangedSince(profile.id!, lastBackedUpAt))) continue;

    needed.push(profile.id!);
  }

  return needed;
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Hook to identify profiles that require a backup reminder.
 *
 * @returns An array of profiles that are due for a backup reminder.
 */
export function useBackupReminders(): Profile[] {
  const profiles = useProfileStore((state) => state.profiles);
  const [reminderIds, setReminderIds] = useState<number[]>([]);

  // The `profiles` array gets a fresh identity from `applySyncedProfile`,
  // `updateProfile`, `pauseSync`, `resumeSync`, `setNormalisation`,
  // `createProfile` and `fetchProfiles` — so every background sync re-ran the
  // whole sweep, database scans included, however little had changed. This
  // signature names exactly the fields the sweep reads, so a renamed bank or a
  // new sync timestamp no longer triggers a walk of two object stores.
  const sweepSignature = useMemo(
    () =>
      profiles
        .filter(couldNeedReminder)
        .map((p) => `${p.id}:${p.lastBackedUpAt}:${p.backupReminderPeriod}`)
        .join("|"),
    [profiles],
  );

  const candidates = useMemo(
    () => profiles.filter(couldNeedReminder),
    // `profiles` is deliberately absent: it is what `sweepSignature` is derived
    // from, and depending on the array itself is the cost being avoided. Every
    // field the sweep reads off these objects is in the signature, so a
    // candidate held from an earlier array cannot be stale in any way that
    // matters — and the ids are resolved against the *current* profiles below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sweepSignature],
  );

  useEffect(() => {
    let cancelled = false;

    sweepForReminders(candidates, Date.now()).then(
      (ids) => {
        if (cancelled) return;
        setReminderIds((current) => (sameIds(current, ids) ? current : ids));
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error("[BackupReminders] Sweep failed:", error);
      },
    );

    // Two overlapping sweeps settle in whatever order the database answers
    // them, so without this an older run could land last and put back a
    // reminder the newer one had already cleared.
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  // Resolved against the live profiles rather than returning the objects the
  // sweep ran on, so the banner names a profile as it is called now.
  return useMemo(
    () =>
      profiles.filter((p) => p.id !== undefined && reminderIds.includes(p.id)),
    [profiles, reminderIds],
  );
}
