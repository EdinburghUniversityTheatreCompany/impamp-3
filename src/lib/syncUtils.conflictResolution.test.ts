/**
 * Resolving a conflict by hand must obey the same rules as resolving one
 * automatically.
 *
 * `syncUtils.hashTwins.test.ts` pins the automatic half: a hash-keyed pad field
 * is a second view of the id-keyed field beside it, so it travels with whichever
 * side won that field and never votes on its own. The hand-resolved half had no
 * such rule and no tests at all — which is how choosing "use the version from
 * the server" for a pad's sounds came back with the remote's ids sitting beside
 * the local hashes. `updateLocalData` believes the hashes, so the user got
 * their own sounds back from the one path that had asked them explicitly, and
 * the mismatch was then published to everyone else.
 *
 * This is the highest-consequence code in the sync system: the moment the app
 * promises the user that their choice will be honoured.
 */
import { describe, expect, it } from "vitest";
import {
  applyConflictResolutions,
  detectProfileConflicts,
  type ConflictResolutionState,
  type ProfileSyncData,
  type SyncedPadConfiguration,
} from "./syncUtils";

const LAST_SYNC = 1_000;
const LOCAL_EDIT = 2_000;
const REMOTE_EDIT = 3_000;
const RESOLVED_AT = 9_000;

const baseProfile = {
  id: 1,
  name: "Test profile",
  syncType: "googleDrive" as const,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function syncData(pads: SyncedPadConfiguration[]): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    _lastSyncTimestamp: LAST_SYNC,
    profile: { ...baseProfile },
    padConfigurations: pads,
    pageMetadata: [],
    audioFiles: [],
  };
}

function pad(
  fields: Partial<SyncedPadConfiguration>,
  modifiedAt: number,
): SyncedPadConfiguration {
  return {
    profileId: 1,
    pageIndex: 0,
    padIndex: 0,
    name: "Horn",
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(modifiedAt),
    _created: 0,
    _modified: modifiedAt,
    ...fields,
  } as SyncedPadConfiguration;
}

/**
 * Both devices changed which sounds this pad plays since the last sync, which
 * is what `detectProfileConflicts` hands to the user rather than deciding.
 */
async function stageSoundConflict(
  remotePad: Partial<SyncedPadConfiguration>,
): Promise<{
  merged: ProfileSyncData;
  conflicts: Awaited<ReturnType<typeof detectProfileConflicts>>["conflicts"];
}> {
  const local = syncData([
    pad(
      {
        audioFileIds: [50],
        audioFileHashes: ["hash-local"],
        audioGainSettings: { 50: 3 },
        audioGainSettingsByHash: { "hash-local": 3 },
        _fieldsModified: {
          audioFileIds: LOCAL_EDIT,
          audioGainSettings: LOCAL_EDIT,
        },
      },
      LOCAL_EDIT,
    ),
  ]);
  const remote = syncData([pad(remotePad, REMOTE_EDIT)]);

  const { conflicts, requiresManualResolution, mergedData } =
    await detectProfileConflicts(local, remote);

  expect(requiresManualResolution).toBe(true);
  // Conflicting items are held back from the merge entirely — the resolution is
  // what puts one back.
  expect(mergedData.padConfigurations).toHaveLength(0);
  return { merged: mergedData, conflicts };
}

const remoteSounds = {
  audioFileIds: [60],
  audioFileHashes: ["hash-remote"],
  audioGainSettings: { 60: -6 },
  audioGainSettingsByHash: { "hash-remote": -6 },
  _fieldsModified: {
    audioFileIds: REMOTE_EDIT,
    audioGainSettings: REMOTE_EDIT,
  },
};

function resolve(
  merged: ProfileSyncData,
  conflicts: Awaited<ReturnType<typeof detectProfileConflicts>>["conflicts"],
  resolutions: ConflictResolutionState,
): SyncedPadConfiguration {
  const resolved = applyConflictResolutions(
    merged,
    conflicts,
    resolutions,
    RESOLVED_AT,
  );
  expect(resolved.padConfigurations).toHaveLength(1);
  return resolved.padConfigurations[0];
}

describe("applyConflictResolutions — hash-keyed twins follow the side the user picked", () => {
  it("takes the remote's hashes when the user takes the remote's sounds", async () => {
    const { merged, conflicts } = await stageSoundConflict(remoteSounds);

    const pad = resolve(merged, conflicts, {
      "0-0": { audioFileIds: "remote", audioGainSettings: "remote" },
    });

    expect(pad.audioFileIds).toEqual([60]);
    // Left as the local hashes, this pad plays the sounds the user did *not*
    // pick — the hashes are what the writer resolves against.
    expect(pad.audioFileHashes).toEqual(["hash-remote"]);
    expect(pad.audioGainSettings).toEqual({ 60: -6 });
    expect(pad.audioGainSettingsByHash).toEqual({ "hash-remote": -6 });
    expect(pad._fieldsModified?.audioFileIds).toBe(REMOTE_EDIT);
  });

  it("keeps the local hashes when the user keeps the local sounds", async () => {
    const { merged, conflicts } = await stageSoundConflict(remoteSounds);

    const pad = resolve(merged, conflicts, {
      "0-0": { audioFileIds: "local", audioGainSettings: "local" },
    });

    expect(pad.audioFileIds).toEqual([50]);
    expect(pad.audioFileHashes).toEqual(["hash-local"]);
    expect(pad.audioGainSettingsByHash).toEqual({ "hash-local": 3 });
    expect(pad._fieldsModified?.audioFileIds).toBe(LOCAL_EDIT);
  });

  it("drops the hashes entirely when the chosen side has none", async () => {
    // A client old enough to predate hashing publishes ids and nothing else.
    const { merged, conflicts } = await stageSoundConflict({
      audioFileIds: [60],
      audioGainSettings: { 60: -6 },
      _fieldsModified: {
        audioFileIds: REMOTE_EDIT,
        audioGainSettings: REMOTE_EDIT,
      },
    });

    const pad = resolve(merged, conflicts, {
      "0-0": { audioFileIds: "remote", audioGainSettings: "remote" },
    });

    expect(pad.audioFileIds).toEqual([60]);
    // Keeping the local hashes would describe the remote's sounds with this
    // device's hashes, which is worse than having no hashes at all.
    expect(pad.audioFileHashes).toBeUndefined();
    expect(pad.audioGainSettingsByHash).toBeUndefined();
  });

  it("resolves each side independently when the user mixes their choices", async () => {
    const { merged, conflicts } = await stageSoundConflict(remoteSounds);

    const pad = resolve(merged, conflicts, {
      "0-0": { audioFileIds: "remote", audioGainSettings: "local" },
    });

    expect(pad.audioFileIds).toEqual([60]);
    expect(pad.audioFileHashes).toEqual(["hash-remote"]);
    // The gain map is keyed by the *other* side's sound, which is a choice the
    // user made rather than a mismatch the merge invented.
    expect(pad.audioGainSettings).toEqual({ 50: 3 });
    expect(pad.audioGainSettingsByHash).toEqual({ "hash-local": 3 });
  });
});
