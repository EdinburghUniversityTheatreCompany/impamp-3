/**
 * Settling a sync conflict, against the orphan sweep — both backends.
 *
 * `syncProfile` and `syncServerProfile` declare their whole run to the
 * audio-import register, and `googleDrive/sync.orphanWindow.test.ts` holds the
 * first of them to it. Conflict resolution is a *second* entry point into the
 * same work: it pushes the resolved blob and then hands it to the very same
 * `updateLocalData`, which resolves each pad's sounds to local rows and writes
 * the pads several steps later. Neither entry point declared anything, so
 * between those two moments the row a pad is about to name is referenced by
 * nothing and `cleanupOrphanedAudioFiles` is entitled to delete it.
 *
 * This is not a rare path, and it is not a background one: settling a conflict
 * is a button in the profile manager, one panel from the orphan cleanup
 * button.
 *
 * One file for both because the fixture and the assertion are the same; the
 * two backends differ only in which push is gated. The pause is that push,
 * which runs immediately before the local write, so the sweep starts with the
 * row already chosen and gets five macrotask turns — undeclared it always
 * wins, declared it always waits.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import {
  createRaceGate,
  longEnoughToDelete,
  type RaceGate,
} from "@/lib/testSupport/raceGate";

stubLoudnessPipeline();

const pushMocks = vi.hoisted(() => ({
  uploadDriveFile: vi.fn(),
  pushServerProfile: vi.fn(),
}));
vi.mock("@/lib/googleDrive/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/googleDrive/api")>()),
  uploadDriveFile: pushMocks.uploadDriveFile,
}));
vi.mock("@/lib/serverSync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serverSync/api")>()),
  pushServerProfile: pushMocks.pushServerProfile,
}));

const { applyConflictResolution } = await import("@/lib/googleDrive/sync");
const { applyServerConflictResolution } = await import("@/lib/serverSync/sync");
const {
  addOrReuseAudioFile,
  cleanupOrphanedAudioFiles,
  computeBlobHash,
  getAudioFile,
  getDb,
  getPadConfigurationsForProfileBank,
} = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;

const PROFILE_ID = 1;
const SERVER_ID = "server-uuid";
const BANK_ID = "0";
const BYTES = "the horn bytes";

const driveCallbacks = {
  onStatusChange: vi.fn(),
  onError: vi.fn(),
  onWarnings: vi.fn(),
  onConflictsDetected: vi.fn(),
  onConflictDataAvailable: vi.fn(),
};

let gate: RaceGate;

beforeEach(async () => {
  vi.clearAllMocks();
  await clearAllStores();
  gate = createRaceGate();
  pushMocks.uploadDriveFile.mockImplementation(async () => {
    await gate.arrive();
    return { id: "remote-file" };
  });
  pushMocks.pushServerProfile.mockImplementation(async () => {
    await gate.arrive();
    return { version: 4 };
  });
  const db = await getDb();
  await db.put("profiles", {
    id: PROFILE_ID,
    name: "Panto",
    syncType: "googleDrive",
    googleDriveFileId: "remote-file",
    serverProfileId: SERVER_ID,
    serverVersion: 3,
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

/** The resolution the user chose: one pad naming one legacy inline sound. */
async function resolvedBlob(): Promise<ProfileSyncData> {
  return {
    _syncFormatVersion: 2,
    profile: { id: PROFILE_ID, name: "Panto" },
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: PROFILE_ID,
        bankId: BANK_ID,
        padIndex: 0,
        name: "Horn",
        playbackType: "sequential",
        audioFileIds: [11],
        createdAt: new Date(0),
        updatedAt: new Date(1000),
      },
    ],
    audioFiles: [
      {
        id: 11,
        name: "horn.wav",
        type: "audio/wav",
        data: Buffer.from(BYTES).toString("base64"),
        hash: await computeBlobHash(new Blob([BYTES], { type: "audio/wav" })),
      },
    ],
  } as unknown as ProfileSyncData;
}

/**
 * The library already holds these bytes under no pad at all, so the resolution
 * adopts this row rather than writing a second one — and the sweep is entitled
 * to it right up until the pad naming it is written.
 */
async function unreferencedRow(): Promise<number> {
  const { id } = await addOrReuseAudioFile({
    name: "horn.wav",
    type: "audio/wav",
    blob: new Blob([BYTES], { type: "audio/wav" }),
  });
  return id;
}

/** Sweeps from inside the gated push, then lets the resolution finish. */
async function sweepFromInsideAResolution(
  resolving: Promise<unknown>,
): Promise<{ deletedCount: number }> {
  await gate.reached;
  const sweeping = cleanupOrphanedAudioFiles();
  await longEnoughToDelete();
  gate.release();
  await resolving;
  return sweeping;
}

/** The pad the resolution applied still names a sound that exists. */
async function expectPadKeptItsSound(held: number): Promise<void> {
  const [pad] = await getPadConfigurationsForProfileBank(PROFILE_ID, BANK_ID);
  expect(pad.audioFileIds).toEqual([held]);
  expect(
    await getAudioFile(held),
    "the resolution named a row the sweep deleted",
  ).toBeDefined();
}

describe("an orphan sweep during conflict resolution", () => {
  it("leaves the row a Drive resolution has chosen but not yet named", async () => {
    const held = await unreferencedRow();
    const sweep = await sweepFromInsideAResolution(
      applyConflictResolution(
        await resolvedBlob(),
        "remote-file",
        PROFILE_ID,
        {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 3600_000,
        },
        driveCallbacks,
        () => {},
      ),
    );

    await expectPadKeptItsSound(held);
    expect(sweep.deletedCount).toBe(0);
  });

  it("leaves the row a server resolution has chosen but not yet named", async () => {
    const held = await unreferencedRow();
    const sweep = await sweepFromInsideAResolution(
      applyServerConflictResolution(PROFILE_ID, await resolvedBlob(), {
        kind: "server",
        serverProfileId: SERVER_ID,
        version: 3,
      }),
    );

    await expectPadKeptItsSound(held);
    expect(sweep.deletedCount).toBe(0);
  });
});
