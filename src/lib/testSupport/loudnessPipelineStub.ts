/**
 * The loudness pipeline, stubbed, for any suite that writes an audio row.
 *
 * `addAudioFile` and `addOrReuseAudioFile` fire `startBackgroundAnalysis`
 * without awaiting it — an import must never block on analysis. In Vitest's
 * node environment that promise reaches Web Audio, rejects, and lands in
 * db.ts's `console.warn` after the test that started it has finished, which
 * tears the worker down with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.
 * Measured at two failing runs in three under `--coverage`, zero without it:
 * instrumentation slows the run enough for the analysis to still be in flight
 * at teardown. The suite stays green and the command exits 1, so treat one
 * passing run as no evidence.
 *
 * `loudness/pipeline.test.ts` and `loudness/loadPipeline.test.ts` must NOT
 * call this — they exercise the real module.
 *
 * `vi.doMock` rather than `vi.mock` is what lets this live in a module at all:
 * `vi.mock` is hoisted into the file it is written in. Call it before the
 * dynamic `import()` the suite uses to load `db.ts`.
 *
 * @returns The stub, for the rare suite that asserts on it
 */

import { vi } from "vitest";

export function stubLoudnessPipeline() {
  const analyseAndStore = vi.fn(async () => null);
  vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));
  return { analyseAndStore };
}
