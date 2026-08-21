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

      expect((result.mergedData.profile as Partial<Profile>)[field]).toEqual(
        mine,
      );
      // No `requiresManualResolution` assertion here, deliberately. The local
      // side is stamped at LAST_SYNC, and the predicate needs the local
      // modification to be *later* than the last sync — so it could never have
      // been true in this fixture whatever the code did. The block below is
      // where that claim belongs, and there both sides really have moved.
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
      expect((result.mergedData.profile as Partial<Profile>)[field]).toEqual(
        mine,
      );
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

  it("keeps the local sounds when only some of them resolve", () => {
    // A three-sound pad missing one came back with two, and the truncated pad
    // was then published, so every other device lost the third as well. The
    // sound is here and wired up; only its description is untranslatable.
    const result = resolveSyncedPadAudio([7, 999], map, [42, 43]);
    expect(result.audioFileIds).toEqual([42, 43]);
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

/**
 * Audio file ids are IndexedDB autoincrement keys, so id 3 means a different
 * recording on every device. The merge used to translate ids on *every* pad
 * through a map keyed by the sender's ids, which silently repointed pads the
 * remote had never touched: local id 3 (a kick) came out as local id 7 (a
 * snare), and the rewritten pad was then pushed to everyone else.
 *
 * Hashes mean the same thing everywhere, so a pad that says which hash it
 * wants cannot be misread by whoever receives it.
 */
describe("detectProfileConflicts — audio references survive an id collision", () => {
  const KICK = "hash-kick";
  const SNARE = "hash-snare";

  /** A pad naming its audio by both routes, as the blob now carries them. */
  const pad = (
    padIndex: number,
    audioFileIds: number[],
    audioFileHashes: (string | null)[],
    modified = LAST_SYNC,
  ) => ({
    profileId: 1,
    bankId: "0",
    padIndex,
    audioFileIds,
    audioFileHashes,
    playbackType: "sequential" as const,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _modified: modified,
    // Newer than the remote's last write, so the merge keeps it rather than
    // raising a local-only conflict. That it has to be said at all is a
    // separate bug, covered by its own test below.
    _created: AFTER,
  });

  it("leaves a purely local pad pointing at the sound it started with", async () => {
    // This device: 3 = kick, 7 = snare. The peer numbers *snare* 3, so the
    // sender-keyed map is {3 -> 7} and the untouched local pad holding [3]
    // used to come back holding [7].
    const local: ProfileSyncData = {
      ...syncData(profile()),
      padConfigurations: [pad(0, [3], [KICK])],
      audioFiles: [
        { id: 3, name: "kick.wav", type: "audio/wav", hash: KICK },
        { id: 7, name: "snare.wav", type: "audio/wav", hash: SNARE },
      ],
    };
    const remote: ProfileSyncData = {
      ...syncData(profile()),
      padConfigurations: [pad(1, [3], [SNARE])],
      audioFiles: [
        { id: 3, name: "snare.wav", type: "audio/wav", hash: SNARE },
      ],
    };

    const { mergedData } = await detectProfileConflicts(local, remote);

    const localPad = mergedData.padConfigurations.find((p) => p.padIndex === 0);
    expect(localPad?.audioFileHashes).toEqual([KICK]);
    // The regression lives in `audioFileIds` — nothing in the translation
    // block writes `audioFileHashes`, so the assertion above holds whether or
    // not the guard exists. This is the one that can fail.
    expect(localPad?.audioFileIds).toEqual([3]);
  });

  it("gives appended remote-only audio an id that is free in the merged list", async () => {
    // Two entries sharing an id makes the blob ambiguous for every reader:
    // updateLocalData builds its map in list order, so the second silently
    // wins and pads resolve to the other recording.
    const local: ProfileSyncData = {
      ...syncData(profile()),
      audioFiles: [{ id: 5, name: "kick.wav", type: "audio/wav", hash: KICK }],
    };
    const remote: ProfileSyncData = {
      ...syncData(profile()),
      audioFiles: [
        { id: 5, name: "snare.wav", type: "audio/wav", hash: SNARE },
      ],
    };

    const { mergedData } = await detectProfileConflicts(local, remote);

    const ids = mergedData.audioFiles.map((f) => f.id);
    expect(new Set(ids).size, "every audio entry needs its own id").toBe(
      ids.length,
    );
  });
});

/**
 * A pad you just made must survive its first sync.
 *
 * "Is this local item new?" was answered against the remote blob's last write
 * *by anyone*, and every push stamps that, including a push that changed
 * nothing. So a second device syncing first was enough to make your new pad
 * look like something the remote had deleted: it became a manual conflict, the
 * sync halted, the pad was left out of the merge, and the modal's "use remote"
 * threw it away. Two devices and a periodic sync is all that takes.
 */
describe("detectProfileConflicts — a new local item survives", () => {
  const newPad = (created: number) => ({
    profileId: 1,
    bankId: "0",
    padIndex: 4,
    name: "Just made",
    audioFileIds: [],
    playbackType: "sequential" as const,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _created: created,
    _modified: created,
  });

  it("keeps a pad created since this device last synced, even after a peer pushed", async () => {
    const local: ProfileSyncData = {
      ...syncData(profile()),
      // This device last synced at LAST_SYNC, then made a pad.
      _lastSyncTimestamp: LAST_SYNC,
      padConfigurations: [newPad(AFTER)],
    };
    // The peer pushed later still, which is what used to condemn the pad.
    const remote: ProfileSyncData = {
      ...syncData(profile()),
      _lastSyncTimestamp: LATER,
      padConfigurations: [],
    };

    const { conflicts, mergedData } = await detectProfileConflicts(
      local,
      remote,
    );

    expect(
      mergedData.padConfigurations.map((p) => p.padIndex),
      "the new pad must reach the merge",
    ).toEqual([4]);
    expect(conflicts).toEqual([]);
  });

  it("still treats a pad the remote really deleted as a conflict", async () => {
    // Created before this device's last sync, so the remote saw it and it is
    // gone now: that is a deletion, and the user has to settle it.
    const local: ProfileSyncData = {
      ...syncData(profile()),
      _lastSyncTimestamp: LATER,
      padConfigurations: [newPad(LAST_SYNC)],
    };
    const remote: ProfileSyncData = {
      ...syncData(profile()),
      _lastSyncTimestamp: LATER,
      padConfigurations: [],
    };

    const { conflicts } = await detectProfileConflicts(local, remote);

    expect(conflicts.map((c) => c.type)).toEqual(["local_only"]);
  });
});
