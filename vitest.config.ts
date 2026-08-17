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
  },
});
