# Probe: the dedup collapse vs an in-flight import

The reproduction for 🔴 1 in [`../repo-review-2026-08-21.md`](../repo-review-2026-08-21.md).

Drop this in as `src/lib/audioDedup.importRace.test.ts`, replacing the
`expect({…}).toEqual({ __show: true })` reporter at the end with the real
assertion — `expect(padPointsAtALiveRow).toBe(true)` — once the fix is in.
Against `86f16bd` it prints:

```
canonicalElected: 2   lowerId: 1   higherId: 2
idTheImportReused: 1
removedFiles: 1   rowsLeft: [2]
padPointsAt: [1]   padPointsAtALiveRow: false
```

```ts
/**
 * Probe: does `collapseDuplicateAudioGroups` delete a row an in-flight import
 * has already reused but not yet referenced from a pad?
 */
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const analyseAndStore = vi.fn(async () => null);
vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));

const { collapseDuplicateAudioGroups, findDuplicateAudioGroups } =
  await import("./audioDedup");
const {
  addAudioFile,
  addOrReuseAudioFile,
  addProfile,
  getDb,
  upsertPadConfiguration,
  withAudioImportInProgress,
  getPadConfigurationsForProfileBank,
} = await import("./db");

function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}
const analysis = {
  algoVersion: 1,
  sampleRate: 48000,
  blockMs: 400,
  hopMs: 100,
  blockMeanSquares: [0.1],
  truePeaks: [0.5],
  channels: 1,
  durationSec: 1,
} as never;

describe("dedup vs in-flight import", () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  it("shows whether the collapse deletes a row an import is holding", async () => {
    const profileId = await addProfile({
      name: "p",
      syncType: "local",
      backupReminderPeriod: 1,
    } as never);

    // Two byte-identical rows, as a pre-dedup library holds. The LOWER id is
    // unanalysed and the HIGHER id carries an analysis, so the collapse elects
    // the higher id as canonical while `addOrReuseAudioFile` hands a reusing
    // caller the lower one.
    const low = await addAudioFile({
      blob: horn(),
      name: "a.wav",
      type: "audio/wav",
    } as never);
    const high = await addAudioFile({
      blob: horn(),
      name: "b.wav",
      type: "audio/wav",
      loudness: analysis,
    } as never);

    const groups = await findDuplicateAudioGroups();
    expect(groups).toHaveLength(1);

    // An import in flight: it has reused a row and has not yet written the pad
    // that names it. A real one awaits a network download here.
    let reusedId = -1;
    let releaseImport!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const importRun = withAudioImportInProgress(async () => {
      const reused = await addOrReuseAudioFile({
        blob: horn(),
        name: "c.wav",
        type: "audio/wav",
      } as never);
      reusedId = reused.id;
      await gate;
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        audioFileIds: [reused.id],
        playbackType: "sequential",
      } as never);
    });
    // Let the reuse happen before the collapse runs.
    await new Promise((r) => setTimeout(r, 0));

    const result = await collapseDuplicateAudioGroups(groups);
    releaseImport();
    await importRun;

    const db = await getDb();
    const survivingIds = await db.getAllKeys("audioFiles");
    const pads = await getPadConfigurationsForProfileBank(profileId, "0");
    const padNames = pads[0]?.audioFileIds ?? [];

    expect({
      canonicalElected: groups[0].canonicalId,
      lowerId: low,
      higherId: high,
      idTheImportReused: reusedId,
      rowsLeft: survivingIds,
      padPointsAt: padNames,
      padPointsAtALiveRow: padNames.every((id) =>
        (survivingIds as number[]).includes(id),
      ),
      removedFiles: result.removedFiles,
    }).toEqual({ __show: true });
  });
});
```
