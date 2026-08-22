/**
 * The last two audio deleters, against an import that is midway through
 * attaching its audio.
 *
 * Between an import's audio write and the pad write that names it there are
 * rows nothing references, which is the whole reason `withAudioImportInProgress`
 * and `settleAudioImports` exist. `findOrphanedAudioFiles`,
 * `cleanupOrphanedAudioFiles` and `collapseDuplicateAudioGroups` all wait.
 * These two did not:
 *
 *  - `deleteProfile` derives what to delete from the profile's own pads and
 *    keeps whatever the *surviving* pads still name — and an import that has
 *    not written its pad yet has no surviving pad to be counted.
 *  - `deleteUnreferencedAudioFiles` was exempted on the grounds that it "only
 *    ever considers ids its own caller just created". Reuse by content hash
 *    ended that: `addOrReuseAudioFile` hands back the id of a row that already
 *    exists, so a pad editor's "provisional" id is routinely a row some other
 *    import is holding. The pad editor's own comment says as much.
 *
 * Both tests below are the same shape as `audioDedup.importRace.test.ts`: an
 * import paused between the two writes, a deleter started and given every
 * chance to finish, and only then the import released. That ordering is what
 * makes the unguarded failure the same one every run rather than a coin toss.
 * The assertion in both is the only one that matters — the pad names a row
 * that exists.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

stubLoudnessPipeline();

const {
  addOrReuseAudioFile,
  addProfile,
  deleteProfile,
  deleteUnreferencedAudioFiles,
  getDb,
  getPadConfigurationsForProfileBank,
  upsertPadConfiguration,
  withAudioImportInProgress,
} = await import("./db");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** One turn of the macrotask queue. */
function macro(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** As many turns as a deleter could possibly need to run to completion. */
async function longEnoughToDelete(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await macro();
}

async function localProfile(name: string): Promise<number> {
  return addProfile({ name, syncType: "local", backupReminderPeriod: 7 });
}

async function audioRowsLeft(): Promise<number[]> {
  const db = await getDb();
  return (await db.getAllKeys("audioFiles")) as number[];
}

/**
 * An import stopped between the row it has been handed and the pad naming it.
 * A real one is awaiting a network download here, which is why the window is
 * wide enough to hit by hand.
 */
async function importPausedHoldingARow(profileId: number): Promise<{
  heldId: number;
  release: () => void;
  done: Promise<void>;
}> {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldId = -1;
  const done = withAudioImportInProgress(async () => {
    const held = await addOrReuseAudioFile({
      name: "horn-from-sync.wav",
      type: "audio/wav",
      blob: horn(),
    });
    heldId = held.id;
    await paused;
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [held.id],
      playbackType: "sequential",
    });
  });

  // Polled rather than given a fixed number of turns: how many microtasks a
  // database transaction takes is fake-indexeddb's business. Asserted rather
  // than assumed, because an import that has not been handed a row yet would
  // make either test below prove nothing.
  while (heldId === -1) await macro();
  return { heldId, release, done };
}

describe("audio deleters against an import in flight", () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  it("deleteProfile leaves the row a reusing import is holding", async () => {
    const doomed = await localProfile("The one being deleted");
    const receiving = await localProfile("The one being synced into");

    // The library already holds the sound, and the profile about to go is the
    // only thing naming it.
    const { id: shared } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    await upsertPadConfiguration({
      profileId: doomed,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [shared],
      playbackType: "sequential",
    });

    const inFlight = await importPausedHoldingARow(receiving);
    expect(inFlight.heldId).toBe(shared);

    const deletion = deleteProfile(doomed);
    await longEnoughToDelete();
    inFlight.release();
    await deletion;
    await inFlight.done;

    const [pad] = await getPadConfigurationsForProfileBank(receiving, "0");
    expect(pad.audioFileIds).toEqual([shared]);
    expect(await audioRowsLeft()).toContain(shared);
  });

  it("deleteUnreferencedAudioFiles leaves the row a reusing import is holding", async () => {
    const receiving = await localProfile("The one being synced into");
    const inFlight = await importPausedHoldingARow(receiving);

    // The user opens the pad editor and picks the same file, so reuse hands
    // back the very row the import is holding; then dismisses the dialog,
    // whose unmount discards every provisional id it was not asked to keep.
    const provisional = await addOrReuseAudioFile({
      name: "horn-picked-by-hand.wav",
      type: "audio/wav",
      blob: horn(),
    });
    expect(provisional).toEqual({ id: inFlight.heldId, reused: true });

    const discard = deleteUnreferencedAudioFiles([provisional.id]);
    await longEnoughToDelete();
    inFlight.release();
    const removed = await discard;
    await inFlight.done;

    expect(removed).toBe(0);
    const [pad] = await getPadConfigurationsForProfileBank(receiving, "0");
    expect(pad.audioFileIds).toEqual([inFlight.heldId]);
    expect(await audioRowsLeft()).toContain(inFlight.heldId);
  });
});
