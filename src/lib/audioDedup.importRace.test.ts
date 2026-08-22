/**
 * The collapse against an import that is midway through attaching its audio.
 *
 * `collapseDuplicateAudioGroups` is one of the five things in this codebase
 * that delete audio rows, and every one of them `await settleAudioImports()`
 * immediately before opening its transaction, because between an import's
 * audio write and the pad write that names it there are rows nothing
 * references. `deleteUnreferencedAudioFiles` was once exempted from that on
 * the grounds that it only ever considers ids its own caller just created;
 * reuse by content hash ended the exemption, and `db.importRace.test.ts` is
 * what it left behind.
 *
 * The collapse considers every row in a duplicate group, so a row an import
 * has *reused* — already handed out, not yet named by any pad — is squarely in
 * range. Two independent choices have to disagree for that to bite, and they
 * do:
 *
 *  - `addOrReuseAudioFile` hands a caller the **lowest** id holding the hash.
 *    `findAudioFileIdByHashIn` takes the first of `index.getAll(hash)`, and
 *    IndexedDB returns equal index keys in primary-key order.
 *  - the collapse elects the canonical **analysed first**, then lowest id, so
 *    that the expensive thing is the thing that survives.
 *
 * They differ whenever a higher-id duplicate carries an analysis and the
 * lowest-id one does not, which is ordinary rather than contrived: analysis is
 * fired without awaiting and is allowed to fail, and `loadPipeline.ts` records
 * a measured run where 14 of 40 files never got one.
 *
 * The fixture below is that shape, and nothing more elaborate. Without the
 * guard the collapse deletes the row the import is holding, the import then
 * writes a pad naming it, and the pad is silent for the rest of the library's
 * life — there is no later pass that could notice, because a pad naming a
 * missing sound is indistinguishable from a pad whose sound the user deleted.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { someAnalysis } from "@/lib/testSupport/audioFixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

stubLoudnessPipeline();

const { collapseDuplicateAudioGroups, findDuplicateAudioGroups } =
  await import("./audioDedup");
const {
  addAudioFile,
  addOrReuseAudioFile,
  addProfile,
  getDb,
  getPadConfigurationsForProfileBank,
  upsertPadConfiguration,
  withAudioImportInProgress,
} = await import("./db");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

describe("collapseDuplicateAudioGroups against an import in flight", () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  it("leaves the row a reusing import is holding, so its pad still has a sound", async () => {
    const profileId = await addProfile({
      name: "Race",
      syncType: "local",
      backupReminderPeriod: 7,
    });

    // Two rows holding identical bytes, as every library written before reuse
    // landed does. The analysis is deliberately on the *higher* id, which is
    // what makes the election and the reuse disagree.
    const lowerId = await addAudioFile({
      blob: horn(),
      name: "horn.wav",
      type: "audio/wav",
    });
    const higherId = await addAudioFile({
      blob: horn(),
      name: "horn-copy.wav",
      type: "audio/wav",
      loudness: someAnalysis(),
    });

    const groups = await findDuplicateAudioGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(higherId);

    // An import partway through: it has been handed a row and has not yet
    // written the pad naming it. A real one is awaiting a network download
    // here, which is why the window is wide enough to hit by hand.
    let releaseImport!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let reusedId = -1;
    const importRun = withAudioImportInProgress(async () => {
      const reused = await addOrReuseAudioFile({
        blob: horn(),
        name: "horn-from-sync.wav",
        type: "audio/wav",
      });
      reusedId = reused.id;
      await paused;
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        audioFileIds: [reused.id],
        playbackType: "sequential",
      });
    });

    // Let the reuse land before the collapse runs. Polled rather than given a
    // fixed number of turns: `addOrReuseAudioFile` opens a database
    // transaction, so how many microtasks it takes is fake-indexeddb's
    // business and not something this test should encode. Without the wait the
    // import has not been handed a row at all and the test would prove
    // nothing, which is why the id is asserted rather than assumed.
    while (reusedId === -1) await new Promise((resolve) => setTimeout(resolve));
    expect(reusedId).toBe(lowerId);

    const collapse = collapseDuplicateAudioGroups(groups);
    // Released only after the collapse has been *started*, so the guard is
    // what has to hold the collapse off — not the ordering of these lines.
    releaseImport();
    await collapse;
    await importRun;

    const db = await getDb();
    const rowsLeft = (await db.getAllKeys("audioFiles")) as number[];
    const [pad] = await getPadConfigurationsForProfileBank(profileId, "0");

    // The invariant, and the only one that matters: the pad names a row that
    // exists. Which row is the collapse's business — having waited, it saw the
    // import's pad and repointed it at the survivor like any other, so this is
    // the canonical rather than the id the import was handed. Asserting the
    // reused id instead would fail for the *right* behaviour and pass for a
    // collapse that skipped the pad entirely.
    expect(rowsLeft).toEqual([higherId]);
    expect(pad.audioFileIds).toEqual([higherId]);
    for (const id of pad.audioFileIds) expect(rowsLeft).toContain(id);
  });
});
