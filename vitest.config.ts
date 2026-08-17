import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the "@/*" alias from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    // Server code talks to node:sqlite and node:crypto — it needs a real Node
    // environment, not jsdom.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
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
      // Today's run is 34.28 / 29.89 / 28.47 / 34.77. The gap below it is
      // deliberate but small: enough that an ordinary refactor moving a few
      // uncovered lines around does not fail the build, not enough for a whole
      // untested module to land unnoticed.
      thresholds: {
        statements: 33,
        branches: 28,
        functions: 27,
        lines: 33,
      },
    },
  },
});
