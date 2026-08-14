import { describe, expect, it } from "vitest";
import type { Profile } from "@/lib/db";
import {
  detectProfileConflicts,
  resolveSyncedPadAudio,
  type ProfileSyncData,
} from "@/lib/syncUtils";

/**
 * Where a profile syncs is per-device bookkeeping, not content. Comparing it
 * across devices raises conflicts over values that are legitimately different
 * on each — and worse, lets a blob written by one device repoint another.
 *
 * These tests pin the fields that must never travel. Two of them were
 * load-bearing bugs: a remote blob could hand a device the *owner's*
 * `googleDriveFolderId` (which then made an editor try to write into someone
 * else's Drive folder), and could raise a manual conflict modal asking the
 * user to choose a `syncType`.
 */

const LAST_SYNC = 1_000;
const AFTER = 2_000;
const LATER = 3_000;

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: "Test",
    syncType: "server",
    lastBackedUpAt: 0,
    backupReminderPeriod: 30,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function syncData(
  p: Profile,
  fieldsModified: Record<string, number> = {},
): ProfileSyncData {
  return {
    _syncFormatVersion: 1,
    _lastSyncTimestamp: LAST_SYNC,
    profile: { ...p, _fieldsModified: fieldsModified },
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
  };
}

/** Every field that describes *where* a profile syncs rather than what it holds. */
const LOCATION_FIELDS: Array<[keyof Profile, unknown, unknown]> = [
  ["syncType", "server", "googleDrive"],
  ["googleDriveFileId", "mine", "theirs"],
  ["googleDriveFolderId", "my-folder", "their-folder"],
  ["serverProfileId", "srv-mine", "srv-theirs"],
  ["serverVersion", 7, 99],
  ["serverShareToken", null, "their-token"],
  ["serverRole", "owner", "viewer"],
  ["audioLocation", "googleDrive", "server"],
  ["readOnly", false, true],
  ["syncPausedUntil", undefined, 9_999_999],
];

describe("detectProfileConflicts — location fields never travel", () => {
  it.each(LOCATION_FIELDS)(
    "keeps the local %s when the remote is newer",
    async (field, mine, theirs) => {
      const local = syncData(profile({ [field]: mine } as Partial<Profile>), {
        [field as string]: LAST_SYNC,
      });
      const remote = syncData(
        profile({ [field]: theirs } as Partial<Profile>),
        {
          [field as string]: LATER,
        },
      );

      const result = await detectProfileConflicts(local, remote);

      expect(result.mergedData.profile[field]).toEqual(mine);
      expect(result.requiresManualResolution).toBe(false);
    },
  );

  it.each(LOCATION_FIELDS)(
    "raises no conflict over %s when both sides changed it",
    async (field, mine, theirs) => {
      const local = syncData(profile({ [field]: mine } as Partial<Profile>), {
        [field as string]: AFTER,
      });
      const remote = syncData(
        profile({ [field]: theirs } as Partial<Profile>),
        {
          [field as string]: AFTER,
        },
      );

      const result = await detectProfileConflicts(local, remote);

      expect(result.conflicts).toEqual([]);
      expect(result.requiresManualResolution).toBe(false);
      expect(result.mergedData.profile[field]).toEqual(mine);
    },
  );
});

describe("detectProfileConflicts — skew between client versions", () => {
  it("does not let an older client's blob erase audioLocation", async () => {
    // A client that predates the field sends a blob without it. The field must
    // survive locally rather than being merged away.
    const local = syncData(profile({ audioLocation: "server" }), {
      audioLocation: LAST_SYNC,
    });
    const remoteProfile = profile();
    delete remoteProfile.audioLocation;
    const remote = syncData(remoteProfile, { name: LATER });

    const result = await detectProfileConflicts(local, remote);

    expect(result.mergedData.profile.audioLocation).toBe("server");
  });

  it("does not let a newer client's blob impose audioLocation", async () => {
    // The reverse skew: our own choice is ours, and arrives through a
    // transition, never through someone else's sync.
    const localProfile = profile();
    delete localProfile.audioLocation;
    const local = syncData(localProfile);
    const remote = syncData(profile({ audioLocation: "server" }), {
      audioLocation: LATER,
    });

    const result = await detectProfileConflicts(local, remote);

    expect(result.mergedData.profile.audioLocation).toBeUndefined();
  });
});

describe("detectProfileConflicts — content still converges", () => {
  it("takes a newer remote name", async () => {
    const local = syncData(profile({ name: "Mine" }), { name: LAST_SYNC });
    const remote = syncData(profile({ name: "Theirs" }), { name: LATER });

    const result = await detectProfileConflicts(local, remote);

    expect(result.mergedData.profile.name).toBe("Theirs");
  });

  it("still asks the user when both sides renamed it", async () => {
    const local = syncData(profile({ name: "Mine" }), { name: AFTER });
    const remote = syncData(profile({ name: "Theirs" }), { name: AFTER });

    const result = await detectProfileConflicts(local, remote);

    expect(result.requiresManualResolution).toBe(true);
    expect(result.conflicts[0].fieldConflicts?.[0].field).toBe("name");
  });
});

describe("resolveSyncedPadAudio", () => {
  const map = new Map<number, number>([[7, 100]]);

  it("translates synced ids into this device's ids", () => {
    const result = resolveSyncedPadAudio([7], map, undefined);
    expect(result.audioFileIds).toEqual([100]);
    expect(result.keptLocal).toBe(false);
  });

  it("drops an id it cannot translate rather than guessing", () => {
    // Keeping it would address a different recording on this device.
    const result = resolveSyncedPadAudio([7, 999], map, undefined);
    expect(result.audioFileIds).toEqual([100]);
    expect(result.unresolved).toEqual([999]);
  });

  it("leaves a pad silent when it had nothing to begin with", () => {
    const result = resolveSyncedPadAudio([999], map, undefined);
    expect(result.audioFileIds).toEqual([]);
    expect(result.keptLocal).toBe(false);
  });

  it("keeps the sound already here when nothing resolves", () => {
    // The regression: a profile hosting its sounds on a deployment that hosts
    // nothing published references with no route to them, and every sync
    // erased another of its author's own pads.
    const result = resolveSyncedPadAudio([999], map, [42]);
    expect(result.audioFileIds).toEqual([42]);
    expect(result.keptLocal).toBe(true);
    expect(result.unresolved).toEqual([999]);
  });

  it("prefers what the blob says when the blob makes sense", () => {
    // Keeping the local sound is a fallback, not a veto: a pad really can be
    // pointed at a different sound by someone else.
    const result = resolveSyncedPadAudio([7], map, [42]);
    expect(result.audioFileIds).toEqual([100]);
    expect(result.keptLocal).toBe(false);
  });
});
