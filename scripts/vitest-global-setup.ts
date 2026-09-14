import { writeBuildInfo } from "./generate-build-info.js";

/**
 * Writes `src/generated/build-info.json` before any suite loads.
 *
 * `src/lib/serviceWorker/register.ts` and the Help modal import that file, and
 * it is generated rather than committed. It used to be written only by npm's
 * `pretest` hooks, which fire for `npm test` and nothing else — so `npx vitest
 * run` (hk's pre-commit step), an editor's test runner, or vitest in watch mode
 * on a fresh clone failed all 11 tests in `register.test.ts` with "Failed to
 * resolve import". Generating it here covers every way vitest is started.
 */
export default function setup() {
  writeBuildInfo();
}
