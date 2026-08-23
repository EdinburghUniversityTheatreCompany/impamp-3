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
      // The floor is a ratchet: set under what the suite actually achieves,
      // so deleting tests or landing a large untested module fails the build
      // and ordinary work does not. Never lowered to make a build pass.
      //
      // History, kept because each raise records what the suite could do at
      // the time. Layered retrigger: 49.65 / 42.80 / 46.37 / 50.45 across
      // three runs, floor 44 / 37 / 39 / 44 from the bank-identity branch
      // before it. The test-quality branch: 50.32 / 43.29 / 46.57 / 51.04.
      // All five lanes merged: 54.43 / 46.32 / 51.25 / 55.14. The audio-dedup
      // and bank-transfer plan: 59.27 / 50.95 / 56.65 / 60.11 as the lowest
      // of four back-to-back runs, floor 60 / 52 / 57 / 61.
      //
      // Raised again by the coverage sweep. Four back-to-back runs on an idle
      // machine measured 73.15 / 64.72 / 70.44 / 74.17 (the lowest seen for
      // each metric; three of the four runs were identical, which is what a
      // suite made mostly of whole branches rather than partially covered
      // modules looks like). The floor sits two points under each. The gate
      // was proved to bite before it was set: 74 / 65 / 71 / 75 exits 1, and
      // reports all four — "Coverage for lines (74.22%) does not meet global
      // threshold (75%)" and one like it per metric — so every one of the
      // four is genuinely under the run rather than merely unenforced.
      //
      // What moved: the two HTTP clients, the Drive request helper and its
      // upload passes, the audio decoder's single-file paths, the preload
      // queue, the playback monitoring loop and the streaming path, the
      // profile store's create/import/export half, and four components that
      // had no test at all — the modal shell, the waveform trimmer, the
      // conflict dialog and the loudness overview — plus the Escape stack
      // they share.
      thresholds: {
        statements: 71,
        branches: 63,
        functions: 69,
        lines: 72,
      },
    },
  },
});
