import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the "@/*" alias from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    // Server code talks to node:sqlite and node:crypto — it needs a real Node
    // environment, not jsdom.
    environment: "node",
    // scripts/ is in here for generate-build-info.test.ts: that script
    // decides what commit the deployed app reports, and it is the one
    // build-time script whose output the app itself reads.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Playwright specs live in e2e-tests/ and are driven by `npm run test:e2e`.
    // Both worktree spellings: `.worktrees/` is the manual convention,
    // `.claude/worktrees/` is where the agent tooling puts them.
    exclude: [
      "node_modules/**",
      "e2e-tests/**",
      ".next/**",
      ".worktrees/**",
      ".claude/worktrees/**",
    ],
    // Headroom over the 5 s default. The loudness suite does real BS.1770
    // arithmetic — a few hundred ms per case unloaded, but it is CPU-bound, so
    // it stretches with whatever else the machine is doing. One case measured
    // 594 ms alone and 6990 ms under parallel load, i.e. failed a limit it
    // normally clears tenfold. That is the same shape as the per-assertion
    // Playwright timeouts recorded in playwright.config.ts: a default written
    // where the work is slow leaves nothing for a loaded CI runner, and the
    // resulting red is about the machine rather than the code. Long enough to
    // absorb load, short enough that a genuine hang still fails the run.
    testTimeout: 20_000,
    /*
     * Coverage, measured so it can only be argued about with numbers.
     *
     * There was no provider in `devDependencies`, no block here and no step in
     * CI, so "711 tests" was the only figure anyone had — and it reads as broad
     * cover when the reality is a third of the lines, concentrated in
     * `lib/server`, `loudness` and `syncUtils` and absent from every store,
     * hook and component. Nothing measured it, so it could only drift down.
     *
     * The thresholds are a ratchet rather than a target: set just under what
     * the suite achieves today, so that deleting tests or landing a large
     * untested module fails the build, and normal work does not. Raise them
     * deliberately when a run comes in comfortably above. Do not lower them to
     * make a build pass.
     */
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // Test files, and the two seams that exist only to be swapped in by
      // tests — counting either would flatter the number without covering a
      // line a user ever runs.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/lib/testSupport/**",
        "src/lib/server/testSupport.ts",
        "src/lib/server/s3/fakeObjectStore.ts",
      ],
      reporter: ["text-summary", "html"],
      // Three back-to-back runs after the layered-retrigger work all measured
      // 49.65 / 42.80 / 46.37 / 50.45; two earlier runs during that work
      // measured 49.72 / 42.70 / 46.32 / 50.48. The floor sits under the
      // *lowest* figure seen for each metric across all five, because the
      // numbers move by a few tenths between runs and a ratchet set against a
      // single run's figure would fail the next one. The gap below that is
      // deliberate but small — enough that an ordinary refactor moving a few
      // uncovered lines around does not fail the build, not enough for a whole
      // untested module to land unnoticed.
      //
      // The previous floor of 44 / 37 / 39 / 44 came from the bank-identity
      // branch and was set against a 45.51 run; layering added five test files
      // and left it five points behind.
      //
      // The test-quality branch then took it to 50.32 / 43.29 / 46.57 / 51.04,
      // identical across two back-to-back runs — the additions are mostly
      // whole branches that were unreachable before (the unconfigured audio
      // deployment, the transaction rollback, the sub-block loudness
      // fallback), which do not move between runs the way a partially covered
      // module does. Floor raised to sit just under, keeping the same small
      // deliberate gap.
      // Raised again after all five lanes merged. The 50/43/46/50 above it was
      // set from the test-quality branch alone, against its own 50.32 run; the
      // other four lanes then added the server redaction, the sync download
      // paths, the import register and the keyboard work, and the combined
      // tree measures 54.43 / 46.32 / 51.25 / 55.14. A floor four points below
      // what the suite actually does is not a ratchet, it is decoration.
      thresholds: {
        statements: 53,
        branches: 45,
        functions: 50,
        lines: 54,
      },
    },
  },
});
