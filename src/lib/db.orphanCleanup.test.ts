/**
 * Cleaning up unreferenced audio must not delete audio something is midway
 * through attaching.
 *
 * The scan and the delete used to be three separate transactions — all audio
 * keys, then all pads, then the deletes — with ordinary awaits in between.
 * Imports write their audio records *before* the pads that name them, so a
 * cleanup running in that window saw a pile of unreferenced files and removed
 * sounds the import was about to point at.
 *
 * One transaction closed the gap between the decision and the delete. It could
 * not close the gap inside an import, which opens before the cleanup is even
 * called, so an import now declares itself (`withAudioImportInProgress`) and
 * the sweeps wait for it. The last test here drives a real import rather than
 * a stand-in for one, because the fix is only worth anything if the import
 * path actually takes the guard — a unit test of the register alone would
 * stay green if `importProfileCore` stopped calling it.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. Its rejection is logged after this file has
// finished, and that log is what tears the worker down mid-run under
// coverage. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

const {
  addProfile,
  addAudioFile,
  upsertPadConfiguration,
  findOrphanedAudioFiles,
  cleanupOrphanedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfileBank,
  getDb,
} = await import("./db");
const { importProfileFromSyncData } = await import("./importExport");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
});

const soundNamed = (name: string) =>
  addAudioFile({
    name,
    type: "audio/wav",
    blob: new Blob([name], { type: "audio/wav" }),
  });

describe("orphaned audio cleanup", () => {
  it("deletes a file no pad names", async () => {
    const orphan = await soundNamed("nobody-wants-me.wav");

    const result = await cleanupOrphanedAudioFiles();

    expect(result.deletedCount).toBe(1);
    expect(await getAudioFile(orphan)).toBeUndefined();
  });

  it("keeps a file a pad still names", async () => {
    const kept = await soundNamed("in-use.wav");
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [kept],
      playbackType: "sequential",
    });

    const result = await cleanupOrphanedAudioFiles();

    expect(result.deletedCount).toBe(0);
    expect(await getAudioFile(kept)).toBeDefined();
  });

  /**
   * A pad write landing while the cleanup is deciding what to delete.
   *
   * Not an import — nothing here declares itself to the sweep — so this is
   * only about the cleanup surviving a concurrent write to the store it holds
   * open. What happens to an import's audio is the test below.
   */
  async function raceCleanupAgainstPadWrite() {
    const arriving = await soundNamed("mid-import.wav");

    const [cleanup] = await Promise.all([
      cleanupOrphanedAudioFiles(),
      upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 1,
        audioFileIds: [arriving],
        playbackType: "sequential",
      }),
    ]);

    const pads = await getPadConfigurationsForProfileBank(profileId, "0");
    return {
      arriving,
      cleanup,
      named: pads.flatMap((pad) => pad.audioFileIds ?? []),
    };
  }

  it("still lands the pad write, whoever wins the race", async () => {
    const { arriving, cleanup, named } = await raceCleanupAgainstPadWrite();

    expect(cleanup.errors).toEqual([]);
    // Guards the setup: without this the invariant below would be vacuous on
    // any change that lost the pad write entirely.
    expect(named).toContain(arriving);
  });

  /**
   * Puts a real import in the gap the defect lived in, and sweeps from inside
   * it.
   *
   * The import reports progress once each sound is committed, which is
   * precisely the moment the bug needs: that record exists and the pad that
   * will name it is two steps away. Firing the sweep from the first of those
   * reports is not a simulation of the window — the import really is in it,
   * which is why this drives the import path rather than a hand-rolled
   * stand-in for one. A unit test of the register alone would stay green if
   * `importProfileCore` ever stopped declaring itself.
   *
   * The progress hook rather than the download hook, because this path
   * downloads four sounds at a time: from inside a download, the first record
   * may not be written yet, and the sweep then finds an empty store and proves
   * nothing.
   *
   * The cleanup is started and deliberately not awaited here: it now waits for
   * the import, and the import is not waiting for it.
   */
  async function sweepFromInsideAnImport() {
    const db = await getDb();
    let sweep: ReturnType<typeof cleanupOrphanedAudioFiles> | undefined;

    const newProfileId = await importProfileFromSyncData(
      db,
      {
        _syncFormatVersion: 2,
        profile: { id: 7, name: "Restored board", syncType: "local" },
        pageMetadata: [],
        padConfigurations: [
          {
            profileId: 7,
            pageIndex: 0,
            padIndex: 3,
            name: "Doorbell",
            playbackType: "round-robin",
            audioFileIds: [11, 12],
          },
        ],
        audioFiles: [
          { id: 11, name: "ding.mp3", type: "audio/mpeg", driveFileId: "d-11" },
          { id: 12, name: "dong.mp3", type: "audio/mpeg", driveFileId: "d-12" },
        ],
      } as unknown as ProfileSyncData,
      async (driveFileId) => new Blob([driveFileId], { type: "audio/mpeg" }),
      () => {
        sweep ??= cleanupOrphanedAudioFiles();
      },
    );

    const pads = await getPadConfigurationsForProfileBank(newProfileId, "0");
    return {
      sweep: await sweep!,
      named: pads.flatMap((pad) => pad.audioFileIds ?? []),
    };
  }

  it("does not delete audio a concurrent import is still attaching", async () => {
    const { sweep, named } = await sweepFromInsideAnImport();

    // Guards the setup: the invariant below is vacuous on a run where the pad
    // never landed, and both sounds have to be on it or the deleted half is
    // the half nobody looks at.
    expect(named).toHaveLength(2);
    expect(sweep.errors).toEqual([]);

    for (const audioFileId of named) {
      expect(
        await getAudioFile(audioFileId),
        `pad names audio ${audioFileId}, which cleanup deleted`,
      ).toBeDefined();
    }
  });

  it("sweeps again once a failed import has released it", async () => {
    // The register is emptied on the way out, not on the way to success: an
    // import that throws must not leave the button dead for the session.
    const db = await getDb();
    await expect(
      importProfileFromSyncData(
        db,
        {
          _syncFormatVersion: 2,
          profile: { id: 8, name: "Doomed", syncType: "local" },
          pageMetadata: [],
          padConfigurations: [],
          audioFiles: [
            { id: 21, name: "gone.mp3", type: "audio/mpeg", driveFileId: "x" },
          ],
        } as unknown as ProfileSyncData,
        async () => null,
      ),
    ).rejects.toThrow();

    const orphan = await soundNamed("left-over.wav");

    expect((await cleanupOrphanedAudioFiles()).deletedCount).toBe(1);
    expect(await getAudioFile(orphan)).toBeUndefined();
  });

  it("reports the same set the scan reports", async () => {
    const orphan = await soundNamed("orphan.wav");
    const kept = await soundNamed("kept.wav");
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [kept],
      playbackType: "sequential",
    });

    const scan = await findOrphanedAudioFiles();

    // Both go through the same `separateOrphans`, so a change to what counts
    // as orphaned cannot reach one and not the other.
    expect([...scan.orphanedIds]).toEqual([orphan]);
    expect([...scan.referencedIds]).toEqual([kept]);
  });
});
