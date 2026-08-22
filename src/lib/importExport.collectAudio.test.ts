/**
 * What an export costs the database before it writes a byte.
 *
 * `collectAudioForPads` is the gathering step of both archive writers — the
 * profile export and the bank export — and it asked for each referenced row
 * with `getAudioFile`, which is a bare `db.get`. Every one of those opens its
 * own transaction, so a full board of 400 sounds opened 400 transactions
 * before the ZIP was started, and a multi-profile export multiplies that by
 * the number of profiles.
 *
 * The set of ids is known up front and none of them changes while the export
 * runs, so the reads belong in one transaction. This measures transactions
 * rather than milliseconds for the reason `testSupport/idbTransactionCounter`
 * gives.
 *
 * The rest of the file pins the behaviour the batching must not alter, because
 * all three of these are load-bearing further downstream:
 *
 *   - a reference whose row is gone is warned about and skipped, not fatal —
 *     otherwise one orphan makes a board unexportable, and
 *     `bankTransfer.test.ts` relies on an archive being able to carry a pad
 *     whose sound `audioFiles` never declares;
 *   - collection is per *row*, so a pad naming one row twice (an ordinary
 *     thing since audio is deduplicated by content hash) carries the bytes
 *     once;
 *   - `audioFiles` and `audioBlobs` keep their shape and their id keys, which
 *     is what the ZIP writer names its entries from.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { countIdbTransactions } from "@/lib/testSupport/idbTransactionCounter";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Before the dynamic imports below, so the rows this file writes do not start
// a background analysis the transaction counter would then see.
stubLoudnessPipeline();

const { collectAudioForPads } = await import("@/lib/importExport");
const { addAudioFile, computeBlobHash } = await import("@/lib/db");
type PadConfiguration = import("@/lib/db").PadConfiguration;

/** Enough that a per-row cost is unmistakable next to a fixed one. */
const SOUNDS = 25;

let counter: ReturnType<typeof countIdbTransactions> | undefined;
let warn: ReturnType<typeof vi.spyOn>;

/** A pad naming exactly the given audio rows, in order. */
function padNaming(padIndex: number, audioFileIds: number[]): PadConfiguration {
  return {
    profileId: 1,
    bankId: "0",
    padIndex,
    audioFileIds,
    playbackType: "sequential",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Writes `count` distinct sounds and returns the ids the store handed back. */
async function seedSounds(count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const blob = new Blob([`sound-${i}`], { type: "audio/mpeg" });
    ids.push(
      await addAudioFile({
        blob,
        name: `sound-${i}.mp3`,
        type: "audio/mpeg",
        hash: await computeBlobHash(blob),
      }),
    );
  }
  return ids;
}

beforeEach(async () => {
  await clearAllStores();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  counter?.restore();
  counter = undefined;
  warn.mockRestore();
});

describe("gathering the audio an export has to carry", () => {
  it("reads the whole set in one transaction, not one per sound", async () => {
    const ids = await seedSounds(SOUNDS);
    const pads = ids.map((id, i) => padNaming(i, [id]));

    counter = countIdbTransactions();
    const { audioFiles } = await collectAudioForPads(pads);
    counter.restore();

    // Guards the measurement: a run that collected nothing would be counting
    // something else entirely.
    expect(audioFiles).toHaveLength(SOUNDS);
    expect(counter.count()).toBeLessThanOrEqual(2);
  });

  it("skips a reference whose row is gone, and warns, rather than failing", async () => {
    const [live] = await seedSounds(1);
    const missing = live + 9000;

    const { audioFiles, audioBlobs } = await collectAudioForPads([
      padNaming(0, [missing, live]),
    ]);

    expect(audioFiles.map((f) => f.id)).toEqual([live]);
    expect([...audioBlobs.keys()]).toEqual([live]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(missing)));
  });

  it("carries a row once however many pads and slots name it", async () => {
    const [shared] = await seedSounds(1);

    const { audioFiles, audioBlobs } = await collectAudioForPads([
      padNaming(0, [shared, shared]),
      padNaming(1, [shared]),
    ]);

    expect(audioFiles).toHaveLength(1);
    expect(audioFiles[0]).toMatchObject({
      id: shared,
      name: "sound-0.mp3",
      type: "audio/mpeg",
    });
    expect(audioFiles[0].hash).toEqual(expect.any(String));
    expect(audioBlobs.size).toBe(1);
    expect(await audioBlobs.get(shared)!.blob.text()).toBe("sound-0");
  });
});
