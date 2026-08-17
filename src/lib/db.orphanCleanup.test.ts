/**
 * Cleaning up unreferenced audio must not delete audio something is midway
 * through attaching.
 *
 * The scan and the delete used to be three separate transactions — all audio
 * keys, then all pads, then the deletes — with ordinary awaits in between.
 * Imports write their audio records *before* the pads that name them, so a
 * cleanup running in that window saw a pile of unreferenced files and removed
 * sounds the import was about to point at.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  addAudioFile,
  upsertPadConfiguration,
  findOrphanedAudioFiles,
  cleanupOrphanedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfilePage,
} = await import("./db");

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
      pageIndex: 0,
      padIndex: 0,
      audioFileIds: [kept],
      playbackType: "sequential",
    });

    const result = await cleanupOrphanedAudioFiles();

    expect(result.deletedCount).toBe(0);
    expect(await getAudioFile(kept)).toBeDefined();
  });

  /**
   * The import order — audio first, pads after — raced against a cleanup.
   *
   * Faithful to what an import really does: `importAudioSources` commits each
   * audio file in a transaction of its own and the pads that name them are
   * written later, so this window is open in production and not an artefact of
   * the harness.
   */
  async function raceCleanupAgainstPadWrite() {
    const arriving = await soundNamed("mid-import.wav");

    const [cleanup] = await Promise.all([
      cleanupOrphanedAudioFiles(),
      upsertPadConfiguration({
        profileId,
        pageIndex: 0,
        padIndex: 1,
        audioFileIds: [arriving],
        playbackType: "sequential",
      }),
    ]);

    const pads = await getPadConfigurationsForProfilePage(profileId, 0);
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

  it.fails(
    "does not delete audio a concurrent import is still attaching",
    async () => {
      // KNOWN DEFECT, deliberately recorded rather than asserted away.
      //
      // This test used to branch on `cleanup.deletedCount` — "if something was
      // deleted the file must be gone, otherwise it must be there" — which is
      // satisfiable either way and never looked at the pad at all. Its comment
      // stated the real invariant and the code checked neither half of it.
      // Reading the pads back shows what was actually happening: the pad
      // deterministically ends up naming a file the cleanup deleted, and the
      // test called that a pass.
      //
      // Making the scan and the delete one transaction, which is what the
      // file's header describes, closes a different window — nothing can start
      // referencing a file *between* the decision and the delete. It does not
      // close this one: the cleanup transaction is created first, so it scans
      // before the pad exists, deletes, and the pad write lands afterwards
      // naming nothing.
      //
      // Closing it is a product decision rather than a test one (a grace
      // period on recently-created audio, one transaction spanning an import's
      // audio and pads, or a lock while an import runs), so it is out of scope
      // here. `it.fails` keeps the invariant written down, keeps the suite
      // honest about it, and turns red the moment the defect is fixed — at
      // which point delete this marker.
      const { named } = await raceCleanupAgainstPadWrite();

      for (const audioFileId of named) {
        expect(
          await getAudioFile(audioFileId),
          `pad names audio ${audioFileId}, which cleanup deleted`,
        ).toBeDefined();
      }
    },
  );

  it("reports the same set the scan reports", async () => {
    const orphan = await soundNamed("orphan.wav");
    const kept = await soundNamed("kept.wav");
    await upsertPadConfiguration({
      profileId,
      pageIndex: 0,
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
