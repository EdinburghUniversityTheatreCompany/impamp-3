import { describe, expect, it } from "vitest";
import { loadLoudnessPipeline } from "./loadPipeline";
import { sourceFilesMatching } from "@/lib/testSupport/sourceScan";

/**
 * Two guards over one rule: the loudness pipeline is imported exactly once.
 *
 * `addAudioFile` fires an analysis per file. When each of those issued its own
 * `import()`, a bulk add lost most of them — from roughly the thirtieth file
 * onwards the import resolved to a namespace whose module body had not run,
 * and `analyseAndStore` threw "Cannot access 'inFlightAnalyses' before
 * initialization" into db.ts's catch. 14 of 40 files and 66 of 100 silently
 * went unanalysed, playing at 0 dB.
 *
 * Neither half is redundant. The first pins the memoisation, which is what
 * makes the module unobservable mid-evaluation. The second pins the part no
 * unit test can reach: a caller that goes back to importing the pipeline
 * directly reintroduces the bug in that caller alone, with every existing
 * test still green.
 */
describe("loadLoudnessPipeline", () => {
  it("imports the module once, however many callers ask", () => {
    const first = loadLoudnessPipeline();
    const second = loadLoudnessPipeline();
    // The same promise, not merely an equivalent one: a second `import()` is
    // the thing that can hand back a half-evaluated module.
    expect(second).toBe(first);
  });

  it("resolves to the real pipeline module", async () => {
    const mod = await loadLoudnessPipeline();
    expect(typeof mod.analyseAndStore).toBe("function");
  });
});

describe("the pipeline has one importer", () => {
  it("is imported nowhere but loadPipeline.ts", () => {
    // The loader itself is the one file allowed to name the module.
    const offenders = sourceFilesMatching(
      /import\(\s*["'][^"']*loudness\/pipeline["']\s*\)/,
      (file) => file.endsWith("loadPipeline.ts"),
    );

    expect(offenders).toEqual([]);
  });
});
