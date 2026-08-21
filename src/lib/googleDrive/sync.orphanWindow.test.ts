/**
 * A sync downloads audio several steps before it writes the pads that name it.
 *
 * That is the same window an import opens, and for the same unavoidable
 * reason: a pad names its sounds by the ids the audio store assigns on write,
 * so the ids do not exist until the audio does. In between, the files are real
 * and nothing references them — which is exactly what `cleanupOrphanedAudioFiles`
 * exists to delete.
 *
 * The import path closed it by declaring itself through
 * `withAudioImportInProgress`, which the sweeps wait on. A sync is the same
 * shape and arguably the worse case, because it runs unattended — on load, on
 * an SSE notification, on a debounce after an edit — while the orphan sweep is
 * a button in the profile manager the user can press at any moment.
 *
 * This drives the real `syncProfile` and sweeps from inside it, rather than
 * testing the register directly: a unit test of the register stays green if
 * the sync path stops taking the guard, which is the only way this can
 * regress. The read-only public-proxy route is the one used because it is the
 * shortest path through `performProfileSync` that downloads audio and then
 * writes pads — the guard sits above both, so it covers the signed-in route
 * with them.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  downloadPublicProfileData: vi.fn(),
  downloadAudioFileAsBlob: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  downloadPublicProfileData: apiMocks.downloadPublicProfileData,
  downloadAudioFileAsBlob: apiMocks.downloadAudioFileAsBlob,
}));

const { syncProfile } = await import("./sync");
const {
  getDb,
  getAudioFile,
  cleanupOrphanedAudioFiles,
  computeBlobHash,
  getPadConfigurationsForProfileBank,
} = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;

const PROFILE_ID = 1;

const callbacks = {
  onStatusChange: vi.fn(),
  onError: vi.fn(),
  onWarnings: vi.fn(),
  onConflictsDetected: vi.fn(),
  onConflictDataAvailable: vi.fn(),
};

/** A shared profile this device may only read, so the sync pulls and applies. */
beforeEach(async () => {
  vi.clearAllMocks();
  await clearAllStores();
  const db = await getDb();
  await db.put("profiles", {
    id: PROFILE_ID,
    name: "Shared board",
    syncType: "googleDrive",
    googleDriveFileId: "remote-file",
    readOnly: true,
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

/** What the fake Drive serves for a given file id. */
const bytesFor = (driveFileId: string) =>
  new Blob([driveFileId], { type: "audio/mpeg" });

/**
 * Two sounds on one pad, so a sweep that deletes the first has a witness.
 *
 * The hashes are of the bytes the fake Drive really serves: a pad resolves its
 * sounds by content hash, so a blob whose refs carry the wrong ones maps
 * nothing and the assertions below would be vacuous.
 */
async function remoteBlob(): Promise<ProfileSyncData> {
  return {
    _syncFormatVersion: 2,
    profile: { id: PROFILE_ID, name: "Shared board" },
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: PROFILE_ID,
        bankId: "0",
        padIndex: 0,
        name: "Doorbell",
        playbackType: "round-robin",
        audioFileIds: [11, 12],
        createdAt: new Date(0),
        updatedAt: new Date(1000),
      },
    ],
    audioFiles: [
      {
        id: 11,
        name: "ding.mp3",
        type: "audio/mpeg",
        driveFileId: "d-11",
        hash: await computeBlobHash(bytesFor("d-11")),
      },
      {
        id: 12,
        name: "dong.mp3",
        type: "audio/mpeg",
        driveFileId: "d-12",
        hash: await computeBlobHash(bytesFor("d-12")),
      },
    ],
  } as unknown as ProfileSyncData;
}

/**
 * Runs a sync and fires the orphan sweep from inside its second download.
 *
 * The second, not the first: by then the first sound is committed and the pad
 * that will name it is several steps away — the window itself, rather than a
 * moment near it. The sweep is deliberately not awaited from in there; it now
 * waits for the sync, and the sync is not waiting for it.
 */
async function sweepFromInsideASync() {
  apiMocks.downloadPublicProfileData.mockResolvedValue(await remoteBlob());

  let sweep: ReturnType<typeof cleanupOrphanedAudioFiles> | undefined;
  apiMocks.downloadAudioFileAsBlob.mockImplementation(
    async (driveFileId: string) => {
      if (driveFileId === "d-12") sweep ??= cleanupOrphanedAudioFiles();
      return bytesFor(driveFileId);
    },
  );

  const result = await syncProfile(PROFILE_ID, null, callbacks, () => {});
  const pads = await getPadConfigurationsForProfileBank(PROFILE_ID, "0");

  return {
    result,
    sweep: await sweep!,
    named: pads.flatMap((pad) => pad.audioFileIds ?? []),
  };
}

describe("an orphan sweep during a sync", () => {
  it("does not delete the audio the sync is still attaching", async () => {
    const { result, sweep, named } = await sweepFromInsideASync();

    // Guards the setup: the invariant below is vacuous if the sync never
    // applied the pad, and both sounds must be on it or the deleted half is
    // the half nobody looks at.
    expect(result.status).toBe("success");
    expect(named).toHaveLength(2);
    expect(sweep.errors).toEqual([]);

    for (const audioFileId of named) {
      expect(
        await getAudioFile(audioFileId),
        `pad names audio ${audioFileId}, which the sweep deleted`,
      ).toBeDefined();
    }
  });

  it("releases the sweep once the sync is done", async () => {
    await sweepFromInsideASync();

    // The register is emptied on the way out, not on the way to success — a
    // sync that finishes must not leave the button dead for the session.
    const after = await cleanupOrphanedAudioFiles();
    expect(after.errors).toEqual([]);
    expect(after.deletedCount).toBe(0);
  });
});
