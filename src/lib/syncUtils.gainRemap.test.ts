import { describe, expect, it } from "vitest";
import { detectProfileConflicts, type ProfileSyncData } from "./syncUtils";

// Pins the sync-merge path's "keep" behaviour end-to-end, through
// detectProfileConflicts itself rather than through remapAudioFileIdKeys in
// isolation. A primitive-level test proves the two modes differ; it proves
// nothing about which mode is actually wired up at this call site. This test
// fails if the merge path is ever switched to "drop" semantics.

const baseProfile = {
  id: 1,
  name: "Test profile",
  syncType: "googleDrive" as const,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeSyncData(
  overrides: Partial<ProfileSyncData> & { profileOverrides?: object } = {},
): ProfileSyncData {
  const { profileOverrides, ...rest } = overrides;
  return {
    _syncFormatVersion: 2,
    profile: { ...baseProfile, ...profileOverrides },
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
    ...rest,
  };
}

describe("detectProfileConflicts — audio-file-keyed pad settings on merge", () => {
  it("remaps a matched remote audio ID to its local ID and keeps an unmatched one under its original ID", async () => {
    // Local device already has one audio file (content-matches remote id 200
    // via hash) but has never seen the second (remote id 201).
    const localData = makeSyncData({
      _lastSyncTimestamp: 1000,
      audioFiles: [
        { id: 50, name: "horn.mp3", type: "audio/mpeg", hash: "hashA" },
      ],
    });

    // Remote has a pad referencing two audio files: 200 (matches local 50 by
    // hash) and 201 (no local counterpart at all).
    const remoteData = makeSyncData({
      _lastSyncTimestamp: 1000,
      padConfigurations: [
        {
          profileId: 1,
          pageIndex: 0,
          padIndex: 0,
          name: "Horn",
          audioFileIds: [200, 201],
          audioTrimSettings: {
            200: { trimStart: 0, trimEnd: 1 },
            201: { trimStart: 0.5, trimEnd: 2 },
          },
          audioGainSettings: { 200: 3, 201: -4 },
          padGainDb: 1.5,
          playbackType: "round-robin",
          createdAt: new Date(0),
          updatedAt: new Date(0),
          // Newer than localLastSync so compareSyncableArrays takes this
          // pad as-is via the remote_only branch, unmodified.
          _created: 5000,
        },
      ],
      audioFiles: [
        { id: 200, name: "horn.mp3", type: "audio/mpeg", hash: "hashA" },
        { id: 201, name: "stab.mp3", type: "audio/mpeg", hash: "hashB" },
      ],
    });

    const { mergedData } = await detectProfileConflicts(localData, remoteData);

    expect(mergedData.padConfigurations).toHaveLength(1);
    const pad = mergedData.padConfigurations[0];

    // 200 had a hash match -> local id 50. 201 had none -> stays 201.
    expect(pad.audioFileIds).toEqual([50, 201]);

    // The matched key moved to its local id; the unmatched key survived
    // under its original remote id, with its value untouched. This is the
    // exact assertion that would fail if "keep" were ever swapped for
    // "drop" at this call site.
    expect(pad.audioTrimSettings).toEqual({
      50: { trimStart: 0, trimEnd: 1 },
      201: { trimStart: 0.5, trimEnd: 2 },
    });
    expect(pad.audioGainSettings).toEqual({ 50: 3, 201: -4 });

    // padGainDb isn't keyed by audio file id, so it just needs to survive.
    expect(pad.padGainDb).toBe(1.5);
  });
});
