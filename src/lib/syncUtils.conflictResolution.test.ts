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
    bankId: "0",
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

/**
 * Every conflict in the suite above starts with an empty `padConfigurations`
 * array — every pad in play is the one conflicting pad, held back from the
 * automatic merge. That leaves `applyConflictResolutions`'s own pad map keyed
 * only by whatever `seedFromLocal` produces, and never exercises the map as
 * it is actually built: from pads the automatic merge already accepted.
 *
 * Two pads sharing a `padIndex` but not a `bankId` is exactly the shape that
 * would collide if that map were still keyed on position — a bug the rest of
 * this file cannot see, because it never gives the map a second pad to
 * collide with.
 */
describe("applyConflictResolutions — pads that share a padIndex across two banks do not collide", () => {
  it("keeps both already-merged pads when neither is in conflict", () => {
    const settledPad = (bankId: string, name: string) => ({
      profileId: 1,
      bankId,
      padIndex: 0,
      name,
      audioFileIds: [],
      playbackType: "sequential" as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    });

    // Both pads already passed the automatic merge untouched — this is the
    // map `applyConflictResolutions` actually builds from in production,
    // never exercised by the field-conflict cases above because those start
    // with an empty `padConfigurations` array.
    const merged = {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [
        settledPad("bank-a", "Kept A"),
        settledPad("bank-b", "Kept B"),
      ],
      pageMetadata: [],
      audioFiles: [],
    } as ProfileSyncData;

    const resolved = applyConflictResolutions(merged, [], {}, RESOLVED_AT);

    const byBankId = new Map(
      resolved.padConfigurations.map((p) => [p.bankId, p]),
    );
    expect(resolved.padConfigurations).toHaveLength(2);
    expect(byBankId.get("bank-a")?.name).toBe("Kept A");
    expect(byBankId.get("bank-b")?.name).toBe("Kept B");
  });
});

/**
 * Same gap, same fix, for banks: `applyConflictResolutions` builds a second
 * map from `pageMetadata`, and no test above ever gives it two
 * already-merged banks to tell apart.
 */
describe("applyConflictResolutions — banks that share a position do not collide", () => {
  it("keeps both already-merged banks when neither is in conflict", () => {
    const settledBank = (bankId: string, name: string) => ({
      profileId: 1,
      bankId,
      pageIndex: 0,
      name,
      isEmergency: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      _created: 0,
      _modified: 0,
      _fieldsModified: {},
    });

    // Both banks landed on the same `pageIndex` mid-reorder, and both
    // already passed the automatic merge untouched — exactly the case
    // `bankId` exists to keep apart.
    const merged = {
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: { ...baseProfile },
      padConfigurations: [],
      pageMetadata: [settledBank("a", "Kept A"), settledBank("b", "Kept B")],
      audioFiles: [],
    } as ProfileSyncData;

    const resolved = applyConflictResolutions(merged, [], {}, RESOLVED_AT);

    const byBankId = new Map(resolved.pageMetadata.map((p) => [p.bankId, p]));
    expect(resolved.pageMetadata).toHaveLength(2);
    expect(byBankId.get("a")?.name).toBe("Kept A");
    expect(byBankId.get("b")?.name).toBe("Kept B");
  });
});
