import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadLoudnessPipeline } from "./loadPipeline";

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
    const root = path.join(import.meta.dirname, "../../../..", "src");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // The loader itself, and test files, which mock it by specifier.
        if (entry.name === "loadPipeline.ts") continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;

        const source = fs.readFileSync(full, "utf8");
        if (/import\(\s*["'][^"']*loudness\/pipeline["']\s*\)/.test(source)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
