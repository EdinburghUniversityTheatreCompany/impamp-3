/**
 * The hash-keyed pad fields and their id-keyed originals must survive a merge
 * saying the *same* thing.
 *
 * Since 2026-08-15 a pad names its sounds by content hash, with the numeric id
 * fields kept alongside for older clients, and `updateLocalData` prefers the
 * hashes wherever both are present. That only holds if the merge treats the two
 * as one fact. It did not: `audioFileIds` is stamped into `_fieldsModified` by
 * `upsertPadConfiguration`, but `audioFileHashes` and the `*ByHash` twins never
 * are — they are synthesised at export — so the merge decided the ids per-field
 * and the hashes by whole-item `_modified`, and the two answers could come from
 * different sides.
 *
 * The result was a merged pad whose ids and hashes named different recordings,
 * with the hashes winning: the pad played the wrong sound, and published it.
 * That is the exact failure the hash fields were added to eliminate,
 * reintroduced through the merge.
 */
import { describe, expect, it } from "vitest";
import { detectProfileConflicts, type ProfileSyncData } from "./syncUtils";

const baseProfile = {
  id: 1,
  name: "Test profile",
  syncType: "googleDrive" as const,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const LAST_SYNC = 1_000;

function syncData(overrides: Partial<ProfileSyncData> = {}): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    _lastSyncTimestamp: LAST_SYNC,
    profile: { ...baseProfile },
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
    ...overrides,
  };
}

/**
 * A pad carrying both representations of the same sound, consistent with each
 * other — which is the only state either side ever publishes.
 */
function pad({
  ids,
  hashes,
  gain,
  gainByHash,
  modified,
  fieldsModified,
}: {
  ids: number[];
  hashes: string[];
  gain?: Record<number, number>;
  gainByHash?: Record<string, number>;
  modified: number;
  fieldsModified?: Record<string, number>;
}) {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: 0,
    name: "Pad",
    playbackType: "round-robin" as const,
    audioFileIds: ids,
    audioFileHashes: hashes,
    audioGainSettings: gain,
    audioGainSettingsByHash: gainByHash,
    _modified: modified,
    _fieldsModified: fieldsModified ?? {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("a merged pad's ids and hashes always name the same sounds", () => {
  it("keeps both from the same side when local's sound swap wins the ids", async () => {
    // Local swapped this pad's sound at t=2000. Remote touched the pad later,
    // at t=3000, but did not touch its audio — so per-field, local's ids win.
    const local = syncData({
      padConfigurations: [
        pad({
          ids: [50],
          hashes: ["hash-local-kick"],
          modified: 2_000,
          fieldsModified: { audioFileIds: 2_000 },
        }),
      ],
    });

    const remote = syncData({
      padConfigurations: [
        pad({
          ids: [90],
          hashes: ["hash-remote-snare"],
          modified: 3_000,
          fieldsModified: { name: 3_000 },
        }),
      ],
    });

    const merged = await detectProfileConflicts(local, remote);
    const mergedPad = merged.mergedData.padConfigurations[0];

    // Whichever side wins, the two representations must agree. Before the fix
    // the ids came from local and the hashes from remote, and because
    // updateLocalData prefers hashes the pad played remote's snare.
    expect(mergedPad.audioFileIds).toEqual([50]);
    expect(mergedPad.audioFileHashes).toEqual(["hash-local-kick"]);
  });

  it("keeps both from the same side when remote's sound swap wins the ids", async () => {
    const local = syncData({
      padConfigurations: [
        pad({
          ids: [50],
          hashes: ["hash-local-kick"],
          modified: 3_000,
          fieldsModified: { name: 3_000 },
        }),
      ],
    });

    const remote = syncData({
      padConfigurations: [
        pad({
          ids: [90],
          hashes: ["hash-remote-snare"],
          modified: 2_000,
          fieldsModified: { audioFileIds: 2_000 },
        }),
      ],
    });

    const merged = await detectProfileConflicts(local, remote);
    const mergedPad = merged.mergedData.padConfigurations[0];

    expect(mergedPad.audioFileIds).toEqual([90]);
    expect(mergedPad.audioFileHashes).toEqual(["hash-remote-snare"]);
  });

  it("carries the gain twin with the gain it belongs to", async () => {
    const local = syncData({
      padConfigurations: [
        pad({
          ids: [50],
          hashes: ["hash-a"],
          gain: { 50: -6 },
          gainByHash: { "hash-a": -6 },
          modified: 2_000,
          fieldsModified: { audioGainSettings: 2_000 },
        }),
      ],
    });

    const remote = syncData({
      padConfigurations: [
        pad({
          ids: [50],
          hashes: ["hash-a"],
          gain: { 50: 3 },
          gainByHash: { "hash-a": 3 },
          modified: 3_000,
          fieldsModified: { name: 3_000 },
        }),
      ],
    });

    const merged = await detectProfileConflicts(local, remote);
    const mergedPad = merged.mergedData.padConfigurations[0];

    // Local's -6 wins per-field; its hash-keyed twin must not be left at
    // remote's +3, which is what the playback path would actually read.
    expect(mergedPad.audioGainSettings).toEqual({ 50: -6 });
    expect(mergedPad.audioGainSettingsByHash).toEqual({ "hash-a": -6 });
  });

  it("does not raise a conflict over a derived field on its own", async () => {
    // The hashes differ only because the ids do. Reporting that separately
    // would ask the user to resolve the same question twice.
    const local = syncData({
      padConfigurations: [
        pad({
          ids: [50],
          hashes: ["hash-local"],
          modified: 2_000,
          fieldsModified: { audioFileIds: 2_000 },
        }),
      ],
    });

    const remote = syncData({
      padConfigurations: [
        pad({
          ids: [90],
          hashes: ["hash-remote"],
          modified: 2_500,
          fieldsModified: { audioFileIds: 2_500 },
        }),
      ],
    });

    const merged = await detectProfileConflicts(local, remote);

    const conflictedFields = merged.conflicts.flatMap((c) =>
      (c.fieldConflicts ?? []).map((f) => f.field),
    );
    expect(conflictedFields).toContain("audioFileIds");
    expect(conflictedFields).not.toContain("audioFileHashes");
  });
});
