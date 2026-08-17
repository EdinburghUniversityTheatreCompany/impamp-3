import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";

const mocks = vi.hoisted(() => ({ hasProfileChangedSince: vi.fn() }));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  hasProfileChangedSince: mocks.hasProfileChangedSince,
}));

import {
  couldNeedReminder,
  sweepForReminders,
} from "@/hooks/useBackupReminders";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: "Show",
    syncType: "local",
    backupReminderPeriod: DAY,
    lastBackedUpAt: NOW - 2 * DAY,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Profile;
}

describe("who is worth asking the database about", () => {
  it("includes an overdue local profile", () => {
    expect(couldNeedReminder(profile())).toBe(true);
  });

  it("skips a profile with reminders turned off", () => {
    expect(couldNeedReminder(profile({ backupReminderPeriod: -1 }))).toBe(
      false,
    );
  });

  it("skips a profile that has never been backed up", () => {
    expect(couldNeedReminder(profile({ lastBackedUpAt: undefined }))).toBe(
      false,
    );
  });

  it("skips a healthily syncing profile, which already has a copy elsewhere", () => {
    expect(
      couldNeedReminder(
        profile({
          syncType: "server",
          serverProfileId: "abc",
          audioLocation: "server",
        }),
      ),
    ).toBe(false);
  });

  it("includes a linked profile whose sync is paused, because the copy is stale", () => {
    expect(
      couldNeedReminder(
        profile({
          syncType: "server",
          serverProfileId: "abc",
          audioLocation: "server",
          // Real clock: getSyncState decides "paused" against Date.now(),
          // while the sweep below takes its `now` as an argument.
          syncPausedUntil: Date.now() + DAY,
        }),
      ),
    ).toBe(true);
  });
});

describe("sweeping the candidates", () => {
  beforeEach(() => {
    mocks.hasProfileChangedSince.mockReset();
  });

  it("reminds about an overdue profile that has changed", async () => {
    mocks.hasProfileChangedSince.mockResolvedValue(true);

    expect(await sweepForReminders([profile()], NOW)).toEqual([1]);
  });

  it("says nothing about an overdue profile that has not changed", async () => {
    mocks.hasProfileChangedSince.mockResolvedValue(false);

    expect(await sweepForReminders([profile()], NOW)).toEqual([]);
  });

  it("does not touch the database for a profile that is not overdue yet", async () => {
    // The expensive half: two full index scans per profile asked about.
    await sweepForReminders([profile({ lastBackedUpAt: NOW - DAY / 2 })], NOW);

    expect(mocks.hasProfileChangedSince).not.toHaveBeenCalled();
  });

  it("measures each profile against its own reminder period", async () => {
    mocks.hasProfileChangedSince.mockResolvedValue(true);

    const ids = await sweepForReminders(
      [
        profile({ id: 1, backupReminderPeriod: DAY }),
        profile({ id: 2, backupReminderPeriod: 30 * DAY }),
      ],
      NOW,
    );

    expect(ids).toEqual([1]);
  });
});
