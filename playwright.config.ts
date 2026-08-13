import { defineConfig, devices } from "@playwright/test";
import { E2E_DB_PATH, E2E_SIGNIN_SECRET, e2eServerEnv } from "./e2e-tests/env";

// Re-exported because the specs import them from here.
export { E2E_DB_PATH, E2E_SIGNIN_SECRET };

// Port is configurable so a git worktree (or a second checkout) can build and
// serve its own copy of the app without colliding with the 3000 a developer
// already has running.
const port = process.env.E2E_PORT ?? "3000";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  // Serve a production build rather than `next dev` unless E2E_DEV_SERVER=1.
  //
  // Turbopack compiles routes on demand, so several browsers hitting a cold
  // dev server time out on work that is really just compilation — that alone
  // accounted for the bulk of this suite's failures and all of its flakiness
  // (dev: 22 passed / 10 flaky / 17 failed; production: 39 passed / 0 flaky).
  // A production server is also roughly twice as fast end to end.
  //
  // NEXT_PUBLIC_GOOGLE_CLIENT_ID must be set for the build to prerender, so
  // fall back to a dummy value: no test signs in to Google.
  webServer: {
    command: process.env.E2E_DEV_SERVER
      ? `npm run dev -- --port ${port}`
      : `npm run build && npm start -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300 * 1000, // 5 minutes — a cold production build is included
    // Shared with scripts/e2e-server.sh — see e2e-tests/env.js.
    env: { PORT: port, ...e2eServerEnv },
  },
});
