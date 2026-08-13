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
    exclude: ["node_modules/**", "e2e-tests/**", ".next/**", ".worktrees/**"],
  },
});
