/**
 * Repairing a missing sound, against an audio deleter.
 *
 * `replaceMissingAudioFile` writes the audio row and the pad naming it in two
 * transactions, and declared nothing in between. That is the writers' half of
 * the rule the deleters keep with `settleAudioImports()`, and a wait is worth
 * nothing when the writer at risk is not in the register to be waited for.
 * `MissingAudioPanel` and `OrphanedAudioPanel` are on the same Maintenance
 * tab, so the deleter is not behind a modal — it is the button above.
 *
 * The mirror of `db.importRace.test.ts`'s second test. There, the row a
 * *reusing import* was holding had to survive the pad editor's discard; here
 * it is the row a *repair* has been handed, and the discard is the deleter
 * that now parks behind a running sync — so it can sit pending for seconds
 * while the user presses Repair.
 *
 * The pause is a gated `arrayBuffer()` on the file the user picks, which
 * `computeBlobHash` awaits before anything is written. Fully deterministic:
 * the deleter is given five macrotask turns to finish, and undeclared it
 * always does. The narrower window *between* the two writes cannot be hit from
 * outside `db.ts` — there is no seam there and, under fake-indexeddb, no
 * macrotask either; an interleaving sweep over the neighbouring turns was
 * measured finding it in one run out of four, which is timing luck rather than
 * a test. What this asserts instead is the property that closes both windows:
 * the register is held for the whole repair.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import {
  createRaceGate,
  longEnoughToDelete,
  type RaceGate,
} from "@/lib/testSupport/raceGate";

stubLoudnessPipeline();

const {
  addOrReuseAudioFile,
  addProfile,
  deleteUnreferencedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfileBank,
  replaceMissingAudioFile,
  upsertPadConfiguration,
} = await import("./db");

const BANK_ID = "0";
const BYTES = "the horn bytes";

/** An id no row has ever had, which is what makes the pad's reference missing. */
const MISSING_AUDIO_ID = 987654;

let gate: RaceGate;

/**
 * The file the user picks off disk, stopped on its first read.
 *
 * A real `File` rather than an object literal, because the unguarded run gets
 * as far as storing it: with the row it meant to reuse deleted, the repair
 * writes a new one, and a plain object with a method on it is not structured
 * cloneable.
 */
class GatedFile extends File {
  override async arrayBuffer(): Promise<ArrayBuffer> {
    await gate.arrive();
    return super.arrayBuffer();
  }
}

beforeEach(async () => {
  await clearAllStores();
  gate = createRaceGate();
});

describe("an audio deleter during a repair", () => {
  it("leaves the row the repair has been handed but not yet named", async () => {
    const profileId = await addProfile({
      name: "The board with a hole in it",
      syncType: "local",
      backupReminderPeriod: 7,
    });
    await upsertPadConfiguration({
      profileId,
      bankId: BANK_ID,
      padIndex: 0,
      audioFileIds: [MISSING_AUDIO_ID],
      playbackType: "sequential",
    });

    // The library already holds these bytes, under no pad at all — a sound the
    // pad editor wrote and was never asked to keep. Reuse is what hands the
    // repair this very row.
    const { id: held } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: new Blob([BYTES], { type: "audio/wav" }),
    });

    const repairing = replaceMissingAudioFile(
      profileId,
      BANK_ID,
      0,
      MISSING_AUDIO_ID,
      new GatedFile([BYTES], "horn-picked-by-hand.wav", { type: "audio/wav" }),
    );
    await gate.reached;

    // The editor is dismissed while the repair is in flight, and its unmount
    // discards every provisional id it was not asked to keep.
    const discard = deleteUnreferencedAudioFiles([held]);
    await longEnoughToDelete();
    gate.release();

    await repairing;
    expect(await discard).toBe(0);

    const [pad] = await getPadConfigurationsForProfileBank(profileId, BANK_ID);
    expect(pad.audioFileIds).toEqual([held]);
    expect(
      await getAudioFile(held),
      "the repair was handed a row the discard then deleted",
    ).toBeDefined();
  });
});
