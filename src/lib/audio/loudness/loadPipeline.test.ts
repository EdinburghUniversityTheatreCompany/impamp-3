import { describe, expect, it, vi } from "vitest";
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

  it("does not memoise a failed import", async () => {
    // A promise is neither null nor undefined once it has rejected, so `??=`
    // holds on to a failure exactly as durably as a success. In a PWA that is
    // not hypothetical: a chunk fetch fails when the network drops or when a
    // redeploy moves chunk hashes under an open tab, and the memo would then
    // disable loudness analysis for the rest of the session — every sound
    // added afterwards playing at 0 dB, with nothing but a console warning to
    // say so, which is the same symptom this file was written to end.
    //
    // A fresh module registry, so this exercises its own memo rather than the
    // one the tests above have already filled with the real pipeline.
    vi.resetModules();
    let attempts = 0;
    vi.doMock("./pipeline", () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("Failed to fetch dynamically imported module");
      }
      return { analyseAndStore: () => Promise.resolve() };
    });

    try {
      const { loadLoudnessPipeline: load } = await import("./loadPipeline");

      await expect(load()).rejects.toThrow();
      // The point of the test: the next caller gets a fresh import, not the
      // rejection the first one already saw.
      const mod = await load();

      expect(attempts).toBe(2);
      expect(typeof mod.analyseAndStore).toBe("function");
    } finally {
      vi.doUnmock("./pipeline");
      vi.resetModules();
    }
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
