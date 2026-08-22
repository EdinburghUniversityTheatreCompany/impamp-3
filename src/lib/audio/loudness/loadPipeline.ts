/**
 * The one place the loudness pipeline is dynamically imported.
 *
 * The pipeline is Web-Audio-only and pulls in the decoder and the analysis
 * worker, so every caller loads it lazily rather than statically — that part
 * is deliberate and unchanged. What was not deliberate is that each caller
 * issued its own `import()`, and `addAudioFile` issues one *per file*.
 *
 * That lost analyses. Adding forty sounds in a loop fired forty imports, and
 * from roughly the thirtieth onwards each one resolved to a namespace whose
 * module body had not run: calling `analyseAndStore` through it threw
 * "Cannot access 'inFlightAnalyses' before initialization", which db.ts
 * catches and logs as a warning. Measured, not inferred — 14 of 40 files and
 * 66 of 100 never got analysed, and the only symptom is that those sounds
 * play at 0 dB normalisation until something re-analyses them. There is a
 * cycle behind it (pipeline.ts imports db.ts, db.ts imports pipeline.ts), and
 * a module caught mid-evaluation is what a cycle hands you.
 *
 * Memoising the promise means the module is imported once however many files
 * arrive, so no caller can observe it part-way through. With this in place
 * the same runs lose nothing: 0 of 40 and 0 of 100.
 *
 * Import the pipeline through here rather than directly —
 * loadPipeline.invariants.test.ts fails the build if a second `import()` of
 * it appears.
 */
let pipeline: Promise<typeof import("./pipeline")> | null = null;

export function loadLoudnessPipeline(): Promise<typeof import("./pipeline")> {
  // A *failure* is not memoised. `??=` cannot tell the two apart — a promise
  // is neither null nor undefined whichever way it settles — so the first
  // failed chunk fetch used to disable loudness analysis for the rest of the
  // session. That is a real event rather than a theoretical one: this is a
  // PWA, and a chunk fetch fails when the network drops or when a redeploy
  // moves chunk hashes under an open tab. Both callers swallow the rejection
  // into a console warning, so the only symptom would be every sound added
  // afterwards playing at 0 dB normalisation — the same silent symptom the
  // memo itself was introduced to end.
  //
  // Clearing the memo inside the catch keeps the single-importer property
  // intact: while the import is in flight every caller still shares one
  // promise, and only a settled failure opens the door to a fresh attempt.
  pipeline ??= import("./pipeline").catch((error: unknown) => {
    pipeline = null;
    throw error;
  });
  return pipeline;
}
