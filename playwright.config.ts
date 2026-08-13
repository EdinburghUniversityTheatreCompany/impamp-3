import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
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
      ? "npm run dev"
      : "npm run build && npm start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 300 * 1000, // 5 minutes — a cold production build is included
    env: {
      NEXT_PUBLIC_GOOGLE_CLIENT_ID:
        process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ??
        "e2e-placeholder.apps.googleusercontent.com",
    },
  },
});
