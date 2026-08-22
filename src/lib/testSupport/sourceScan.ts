/**
 * Reading the source tree as text, for rules no type or assertion can hold.
 *
 * Two of them exist so far, and they have the same shape: "nobody, anywhere,
 * writes this call". The loudness pipeline must be imported through
 * `loadPipeline.ts` and nowhere else, and nothing may look a sound up by its
 * name. Neither can be caught by exercising the code, because the failure is a
 * *new* call site in a file the test does not import — so the test has to go
 * and look.
 *
 * The walk was written out twice and jscpd, which runs at threshold 0, refused
 * the second copy. That is the gate working: this is the third caller's
 * starting point.
 */

import fs from "node:fs";
import path from "node:path";

/** `src/`, from this file's home in `src/lib/testSupport/`. */
const SRC_ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * Every non-test `.ts`/`.tsx` file under `src/` whose text matches `pattern`.
 *
 * Test files are always skipped: they name the very thing being banned, both
 * to mock it and to say what is banned, and a rule that flagged its own guard
 * would be unusable.
 *
 * @param pattern - Tested against each file's whole text. Do not pass a `/g`
 *   regex: `RegExp.test` carries `lastIndex` between calls and would skip
 *   files.
 * @param skip - Called with each candidate's path relative to `src/`; return
 *   true to exclude it. This is where the one legitimate call site goes.
 * @returns The matching paths, relative to `src/` and sorted, so an assertion
 *   against a literal list does not depend on directory order
 */
export function sourceFilesMatching(
  pattern: RegExp,
  skip: (relativePath: string) => boolean = () => false,
): string[] {
  const hits: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      const relative = path.relative(SRC_ROOT, full);
      if (skip(relative)) continue;
      if (pattern.test(fs.readFileSync(full, "utf8"))) hits.push(relative);
    }
  };

  walk(SRC_ROOT);
  return hits.sort();
}
