/**
 * `updateLocalData` — the Drive sync path — with gain settings on a linked
 * profile.
 *
 * This is the combination nothing covered. `syncUtils.gainRemap.test.ts` pins
 * the *merge* half (detectProfileConflicts, "keep" mode), but the merge only
 * decides what the blob should say. `updateLocalData` is what writes it to
 * this device, under the opposite remap mode, against real local audio ids —
 * and it is the only place the `keptLocal` branch exists.
 *
 * These are integration tests against a real IndexedDB, not unit tests of the
 * remap helper. A helper-level test proves the two modes differ; it proves
 * nothing about which one this call site wires up, or about what happens to a
 * *local* setting when the synced audio cannot be resolved.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import { addAudioFiles as addAudio } from "@/lib/testSupport/audioFixtures";

const { updateLocalData } = await import("./dataAccess");
const { getDb } = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;
type PadConfiguration = import("@/lib/db").PadConfiguration;

const PROFILE_ID = 1;

/** A profile already linked to the app's own server, with audio in Drive. */
const localProfileRecord = {
  id: PROFILE_ID,
  name: "Show board",
  syncType: "server" as const,
  audioLocation: "googleDrive" as const,
  googleDriveFileId: "local-drive-file",
  googleDriveFolderId: "local-drive-folder",
  serverProfileId: "srv-1",
  serverVersion: 7,
  serverShareToken: "tok-1",
  serverRole: "editor" as const,
  readOnly: false,
  followOnly: false,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/**
 * What a collaborator's blob claims about where the profile syncs — all of it
 * wrong for this device, and none of it allowed to win.
 */
const remoteProfileClaim = {
  id: 99,
  name: "Their name for it",
  syncType: "local" as const,
  audioLocation: null,
  googleDriveFileId: "their-drive-file",
  googleDriveFolderId: "their-drive-folder",
  serverProfileId: "srv-999",
  serverVersion: 1,
  serverShareToken: "tok-999",
  serverRole: "viewer" as const,
  readOnly: true,
  followOnly: true,
  lastBackedUpAt: 0,
  backupReminderPeriod: 0,
  createdAt: new Date(0),
  updatedAt: new Date(1000),
};

function syncData(overrides: Partial<ProfileSyncData> = {}): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: remoteProfileClaim,
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
    ...overrides,
  } as unknown as ProfileSyncData;
}

function pad(overrides: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: PROFILE_ID,
    pageIndex: 0,
    padIndex: 0,
    name: "Horn",
    audioFileIds: [],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(1000),
    ...overrides,
  } as PadConfiguration;
}

async function putLocalPad(config: Partial<PadConfiguration>) {
  const db = await getDb();
  await db.add("padConfigurations", pad(config));
}

/**
 * Syncs a blob carrying one sound the local device can resolve by hash — the
 * sender calls it 200 — on a single pad whose settings the caller supplies.
 */
async function syncResolvableSound(padOverrides: Partial<PadConfiguration>) {
  return updateLocalData(
    PROFILE_ID,
    syncData({
      audioFiles: [
        { id: 200, name: "horn.mp3", type: "audio/mpeg", hash: "hash-A" },
      ],
      padConfigurations: [pad({ audioFileIds: [200], ...padOverrides })],
    }),
  );
}

async function readPad(pageIndex = 0, padIndex = 0) {
  const db = await getDb();
  return db
    .transaction("padConfigurations")
    .objectStore("padConfigurations")
    .index("profilePagePad")
    .get([PROFILE_ID, pageIndex, padIndex]);
}

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  await db.put("profiles", localProfileRecord);
});

describe("updateLocalData — gain settings on a linked profile", () => {
  it("remaps gain settings onto this device's audio ids when the synced audio resolves", async () => {
    // The local device already holds this recording; the sender knows it as 200.
    const [localId] = await addAudio([{ name: "horn.mp3", hash: "hash-A" }]);

    await syncResolvableSound({
      audioGainSettings: { 200: 4.5 },
      audioTrimSettings: { 200: { trimStart: 0, trimEnd: 2 } },
      padGainDb: -1.5,
    });

    const stored = await readPad();
    expect(stored?.audioFileIds).toEqual([localId]);
    // The gain followed its sound across the id translation. Left keyed by the
    // sender's 200, it would apply to whatever this device calls 200 — or to
    // nothing at all.
    expect(stored?.audioGainSettings).toEqual({ [localId]: 4.5 });
    expect(stored?.audioTrimSettings).toEqual({
      [localId]: { trimStart: 0, trimEnd: 2 },
    });
    // Not keyed by audio id, so it only has to survive the round trip.
    expect(stored?.padGainDb).toBe(-1.5);
  });

  it("drops a gain setting whose audio could not be resolved, rather than keeping it under the sender's id", async () => {
    // Two sounds arrive: one resolves by hash, the other is Drive-only and was
    // never pre-downloaded, so it never enters the id map.
    const [localId] = await addAudio([{ name: "horn.mp3", hash: "hash-A" }]);

    const warnings = await updateLocalData(
      PROFILE_ID,
      syncData({
        audioFiles: [
          { id: 200, name: "horn.mp3", type: "audio/mpeg", hash: "hash-A" },
          {
            id: 201,
            name: "stab.mp3",
            type: "audio/mpeg",
            hash: "hash-B",
            driveFileId: "drive-201",
          },
        ],
        padConfigurations: [
          pad({
            audioFileIds: [200, 201],
            audioGainSettings: { 200: 4.5, 201: -6 },
          }),
        ],
      }),
    );

    const stored = await readPad();
    expect(stored?.audioFileIds).toEqual([localId]);
    // 201's gain is gone. Keeping it would leave −6 dB keyed by 201, which on
    // this device addresses a different recording entirely.
    expect(stored?.audioGainSettings).toEqual({ [localId]: 4.5 });
    expect(warnings.join(" ")).toContain("201");
  });

  it("keeps the local gain settings untouched when the pad falls back to the sound already on this device", async () => {
    // The keptLocal branch, which exists only in this function.
    const [resolvableId, keptId] = await addAudio([
      { name: "horn.mp3", hash: "hash-A" },
      { name: "kept.mp3", hash: "hash-KEPT" },
    ]);

    // The pad on this device, with gain and trim keyed by *this device's* ids.
    await putLocalPad({
      audioFileIds: [keptId],
      audioGainSettings: { [keptId]: 9 },
      audioTrimSettings: { [keptId]: { trimStart: 1, trimEnd: 3 } },
    });

    const warnings = await updateLocalData(
      PROFILE_ID,
      syncData({
        audioFiles: [
          // Resolves — and is deliberately numbered `keptId` on the sender's
          // side. If the local settings were run through the remap, this is
          // the mapping that would carry the kept sound's 9 dB onto a
          // different recording.
          { id: keptId, name: "horn.mp3", type: "audio/mpeg", hash: "hash-A" },
          // Referenced by the incoming pad, Drive-only, never downloaded — so
          // the pad resolves to nothing and falls back to what is already here.
          {
            id: 201,
            name: "missing.mp3",
            type: "audio/mpeg",
            hash: "hash-MISSING",
            driveFileId: "drive-201",
          },
        ],
        padConfigurations: [
          pad({
            audioFileIds: [201],
            audioGainSettings: { 201: -12 },
            audioTrimSettings: { 201: { trimStart: 0, trimEnd: 0.5 } },
          }),
        ],
      }),
    );

    const stored = await readPad();
    expect(stored?.audioFileIds).toEqual([keptId]);
    // The local settings survived, still keyed by the local id, with the local
    // value. The sender's −12 dB belongs to a sound that never arrived.
    expect(stored?.audioGainSettings).toEqual({ [keptId]: 9 });
    expect(stored?.audioTrimSettings).toEqual({
      [keptId]: { trimStart: 1, trimEnd: 3 },
    });
    // The specific corruption the branch exists to prevent: 9 dB must not have
    // been translated onto the sound the sender happened to call `keptId`.
    expect(stored?.audioGainSettings?.[resolvableId]).toBeUndefined();
    expect(warnings.join(" ")).toContain(
      "kept the sound already on this device",
    );
  });

  it("updates pad gain without letting the blob repoint where the profile syncs", async () => {
    // The combination this file exists for: a profile that is linked *and*
    // carries gain. The link is this device's answer; the gain is the blob's.
    const [localId] = await addAudio([{ name: "horn.mp3", hash: "hash-A" }]);

    await syncResolvableSound({
      audioGainSettings: { 200: 2 },
      padGainDb: 3,
    });

    const db = await getDb();
    const profile = await db.get("profiles", PROFILE_ID);

    // Every link field is still this device's.
    expect(profile?.syncType).toBe("server");
    expect(profile?.serverProfileId).toBe("srv-1");
    expect(profile?.serverShareToken).toBe("tok-1");
    expect(profile?.serverRole).toBe("editor");
    expect(profile?.googleDriveFileId).toBe("local-drive-file");
    expect(profile?.googleDriveFolderId).toBe("local-drive-folder");
    expect(profile?.audioLocation).toBe("googleDrive");
    expect(profile?.readOnly).toBe(false);
    expect(profile?.followOnly).toBe(false);
    expect(profile?.name).toBe("Show board");

    // And the gain the blob carried did land.
    const stored = await readPad();
    expect(stored?.audioGainSettings).toEqual({ [localId]: 2 });
    expect(stored?.padGainDb).toBe(3);
  });
});
