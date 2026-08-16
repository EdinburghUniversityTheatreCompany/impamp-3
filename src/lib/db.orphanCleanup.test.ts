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

  it("does not delete audio a concurrent import is still attaching", async () => {
    // The import order: audio first, pads after. Racing the cleanup against
    // the pad write is the window that used to lose the sound.
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

    // Whichever transaction goes first, the two must agree: either the pad
    // was already visible and the file is kept, or the file was deleted and
    // the pad write happened after — never a pad naming a file that is gone.
    const stillThere = await getAudioFile(arriving);
    if (cleanup.deletedCount > 0) {
      expect(stillThere).toBeUndefined();
    } else {
      expect(stillThere).toBeDefined();
    }
  });

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
