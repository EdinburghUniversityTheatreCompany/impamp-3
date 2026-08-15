/**
 * `updateLocalData` resolving a pad's audio by content hash.
 *
 * Audio file ids are IndexedDB autoincrement keys, so id 3 names a different
 * recording on every device, and the sender's ids are the only thing the blob
 * used to carry. Every reader therefore had to work out whose ids it was
 * looking at, and the merge could not: it translated pads the remote had never
 * touched, so a local kick came back as a snare and was published as one.
 *
 * A hash means the same recording everywhere. These tests are against a real
 * IndexedDB rather than the resolver in isolation, because what matters is
 * that the *call site* prefers hashes and that the ids the store hands out
 * really do collide with the sender's.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import { addAudioFiles } from "@/lib/testSupport/audioFixtures";

const { updateLocalData, getLocalProfileSyncData } =
  await import("./dataAccess");
const { getDb } = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;
type PadConfiguration = import("@/lib/db").PadConfiguration;

const PROFILE_ID = 1;
const KICK = "hash-kick";
const SNARE = "hash-snare";

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  await db.put("profiles", {
    id: PROFILE_ID,
    name: "Show board",
    syncType: "server",
    audioLocation: "googleDrive",
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

function syncData(overrides: Partial<ProfileSyncData>): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: { id: PROFILE_ID, name: "Show board" },
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
    ...overrides,
  } as unknown as ProfileSyncData;
}

const syncedPad = (overrides: Record<string, unknown>) => ({
  audioFileIds: [] as number[],
  profileId: PROFILE_ID,
  pageIndex: 0,
  padIndex: 0,
  name: "Hit",
  playbackType: "sequential" as const,
  createdAt: new Date(0),
  updatedAt: new Date(1000),
  ...overrides,
});

const padAt = async (padIndex: number): Promise<PadConfiguration> => {
  const db = await getDb();
  const all = await db.getAllFromIndex(
    "padConfigurations",
    "profileId",
    PROFILE_ID,
  );
  return all.find((p) => p.padIndex === padIndex)!;
};

describe("updateLocalData — resolving audio by hash", () => {
  it("follows the hash, not the sender's id, when the two disagree", async () => {
    const [kickId, snareId] = await addAudioFiles([
      { name: "kick.wav", hash: KICK },
      { name: "snare.wav", hash: SNARE },
    ]);

    // What a merged blob looks like: it carries pads from both sides, so a
    // pad's ids are not necessarily the ids the audio list is keyed by. Here
    // the list says id `kickId` is the *snare*, while the pad that holds
    // `kickId` is this device's own and means the kick.
    //
    // Resolving by id therefore lands on the snare, which is the corruption.
    // Resolving by hash cannot: the pad said which recording it wanted.
    await updateLocalData(
      PROFILE_ID,
      syncData({
        audioFiles: [
          { id: kickId, name: "snare.wav", type: "audio/wav", hash: SNARE },
          { id: 999, name: "kick.wav", type: "audio/wav", hash: KICK },
        ],
        padConfigurations: [
          syncedPad({
            audioFileIds: [kickId],
            audioFileHashes: [KICK],
          }),
        ],
      }),
    );

    expect(
      (await padAt(0)).audioFileIds,
      "the pad must keep the sound it named",
    ).toEqual([kickId]);
    expect(snareId).not.toBe(kickId);
  });

  it("re-keys trim and gain by hash too", async () => {
    const [kickId, snareId] = await addAudioFiles([
      { name: "kick.wav", hash: KICK },
      { name: "snare.wav", hash: SNARE },
    ]);

    await updateLocalData(
      PROFILE_ID,
      syncData({
        audioFiles: [
          { id: kickId, name: "snare.wav", type: "audio/wav", hash: SNARE },
        ],
        padConfigurations: [
          syncedPad({
            audioFileIds: [kickId],
            audioFileHashes: [SNARE],
            audioTrimSettingsByHash: {
              [SNARE]: { trimStart: 0.5, trimEnd: 1.5 },
            },
            audioGainSettingsByHash: { [SNARE]: -3 },
          }),
        ],
      }),
    );

    const stored = await padAt(0);
    // Keyed by the local id for the snare, never the sender's id for it.
    expect(stored.audioTrimSettings).toEqual({
      [snareId]: { trimStart: 0.5, trimEnd: 1.5 },
    });
    expect(stored.audioGainSettings).toEqual({ [snareId]: -3 });
  });

  it("still reads a blob from a client that sends no hashes", async () => {
    // The whole point of adding the fields rather than replacing them: a
    // client running older code keeps working, with no migration.
    const [kickId] = await addAudioFiles([{ name: "kick.wav", hash: KICK }]);

    await updateLocalData(
      PROFILE_ID,
      syncData({
        audioFiles: [
          { id: 900, name: "kick.wav", type: "audio/wav", hash: KICK },
        ],
        padConfigurations: [syncedPad({ audioFileIds: [900] })],
      }),
    );

    expect((await padAt(0)).audioFileIds).toEqual([kickId]);
  });
});

describe("getLocalProfileSyncData — publishing both routes", () => {
  it("names each sound by hash alongside the id it has here", async () => {
    const [kickId] = await addAudioFiles([{ name: "kick.wav", hash: KICK }]);
    const db = await getDb();
    await db.add("padConfigurations", {
      profileId: PROFILE_ID,
      pageIndex: 0,
      padIndex: 2,
      name: "Kick",
      audioFileIds: [kickId],
      audioTrimSettings: { [kickId]: { trimStart: 0, trimEnd: 1 } },
      audioGainSettings: { [kickId]: -6 },
      playbackType: "sequential",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as PadConfiguration);

    const blob = await getLocalProfileSyncData(PROFILE_ID);
    const pad = blob!.padConfigurations.find((p) => p.padIndex === 2)!;

    expect(pad.audioFileIds).toEqual([kickId]);
    expect(pad.audioFileHashes).toEqual([KICK]);
    expect(pad.audioTrimSettingsByHash).toEqual({
      [KICK]: { trimStart: 0, trimEnd: 1 },
    });
    expect(pad.audioGainSettingsByHash).toEqual({ [KICK]: -6 });
  });
});
