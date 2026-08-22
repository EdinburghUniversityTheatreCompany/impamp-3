/**
 * The loudness pipeline, stubbed, for any suite that writes an audio row.
 *
 * `addAudioFile` and `addOrReuseAudioFile` both call `startBackgroundAnalysis`,
 * which fires `loadLoudnessPipeline().then(({ analyseAndStore }) => …)` and
 * deliberately does not await it — an import must never block on analysis. In
 * Vitest's node environment that promise reaches Web Audio, rejects, and lands
 * in db.ts's `console.warn`. Which is *after* the test that started it has
 * finished, and often after the whole file has.
 *
 * That is not merely untidy. A run of `vitest run --coverage` failed on two of
 * three consecutive attempts with
 *
 *     EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending
 *
 * — fifteen of them, all traced to one file, while all 1409 tests passed. The
 * suite is green and the command exits 1, which is the most expensive kind of
 * red: the natural reading is that your change broke something. Coverage is
 * what makes it likely rather than certain, because instrumentation slows the
 * run enough for the analysis to still be in flight at teardown; without
 * `--coverage` the same run was clean. It is timing, so treat "it passed once"
 * as no evidence at all.
 *
 * Two suites must NOT call this — `loudness/pipeline.test.ts` and
 * `loudness/loadPipeline.test.ts` exercise the real module, which is the whole
 * point of them. Everything else that writes a row should.
 *
 * `vi.doMock` rather than `vi.mock`, which is what lets this live in a module
 * at all: `vi.mock` is hoisted into the file it is written in and cannot be
 * called on another file's behalf. `vi.doMock` applies to *subsequent dynamic
 * imports*, so call this before the `await import(…)` the suite already uses to
 * load `db.ts` after `window` exists.
 *
 * @returns The stub, for the rare suite that wants to assert on it
 */

import { vi } from "vitest";

export function stubLoudnessPipeline() {
  const analyseAndStore = vi.fn(async () => null);
  vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));
  return { analyseAndStore };
}
