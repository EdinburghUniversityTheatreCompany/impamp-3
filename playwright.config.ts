import { defineConfig, devices } from "@playwright/test";
import {
  E2E_ADMIN_EMAIL,
  E2E_DB_PATH,
  E2E_S3_PORT,
  E2E_SIGNIN_SECRET,
  e2eServerEnv,
} from "./e2e-tests/env";

// Re-exported because the specs import them from here.
export { E2E_ADMIN_EMAIL, E2E_DB_PATH, E2E_S3_PORT, E2E_SIGNIN_SECRET };

// Port is configurable so a git worktree (or a second checkout) can build and
// serve its own copy of the app without colliding with the 3000 a developer
// already has running.
const port = process.env.E2E_PORT ?? "3000";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: true,
  // Playwright's defaults are 30 s per test and 5 s per expect. Both are too
  // tight for this suite under parallel load: assigning a sound reads a file,
  // decodes it, writes a Blob to IndexedDB and re-renders, and with several
  // workers competing that comfortably exceeds 5 s on a busy machine. That was
  // the whole of the "edit-mode is flaky" report — assertions timing out, no
  // race in the app. Raising the ceiling costs nothing on a passing run, since
  // expect polls and returns the moment it matches; it only changes how long a
  // slow step is given before it is called a failure.
  //
  // So: don't reintroduce per-assertion `{ timeout: 5000 }`. That is the old
  // default written out longhand, and pinning an assertion back down to it is
  // what made these tests flaky. Only pass a timeout to raise it above this.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Claims the admin account, which is whichever account signs in first. See
  // e2e-tests/global-setup.ts.
  globalSetup: "./e2e-tests/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Two workers in CI, not one.
  //
  // Every flake this suite has had came from parallel load — the comments
  // above and in the specs say so repeatedly — and the developer who reports
  // one is running ten workers with no retries. A single-worker CI run with
  // two retries is therefore the most forgiving configuration anyone runs, and
  // a green result from it says the suite passes when nothing competes with
  // it, which is not the claim anyone wants from CI. The last real bug found
  // this way spent weeks being read as noise, because CI could not see it.
  //
  // Two rather than four: a GitHub runner has 4 vCPUs, and this suite decodes
  // audio and writes blobs to IndexedDB, so it is not cheap per worker. Two
  // roughly halves the wall clock as well, which pays for the contention it
  // buys. Anything that now flakes at two workers would have flaked on a
  // developer's machine at ten, so it is a real report, not new noise.
  workers: process.env.CI ? 2 : undefined,
  // Three reporters, and the `line` one is the reason this is a list.
  //
  // With `html` alone a local run prints nothing until it ends and then opens
  // a browser, which is indistinguishable from a hang and was half of why
  // `npm run test:e2e` read as "your change broke everything". `line` puts the
  // progress back on stdout for CI logs and terminals alike; `open: "never"`
  // stops the report server from holding the terminal after a failure — run
  // `npx playwright show-report` when you actually want it. The HTML report is
  // still the artifact, and the flaky reporter still makes retries visible
  // without opening it. See e2e-tests/flaky-reporter.ts.
  reporter: [
    ["line"],
    ["html", { open: "never" }],
    ["./e2e-tests/flaky-reporter.ts"],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /portrait-layout\.spec\.ts/,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: /portrait-layout\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: /portrait-layout\.spec\.ts/,
    },
    // A phone, in portrait, with touch — running exactly one spec.
    //
    // Deliberately not a fourth full-suite browser. The other 190-odd specs
    // are written against `devices["Desktop Chrome"]` (1280x720, no touch);
    // running them at 390px would assert a layout nobody designed and would
    // double an already long suite for no signal. CI still gates on chromium
    // alone, and this project is what `npm run test:e2e:portrait` runs.
    //
    // The `testIgnore` above is the other half: without it the portrait spec
    // would also run at 1280px, where every one of its assertions passes
    // trivially and therefore proves nothing.
    {
      name: "mobile-portrait",
      use: { ...devices["Pixel 7"] },
      testMatch: /portrait-layout\.spec\.ts/,
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
  // The database is emptied here rather than in a `globalSetup`, because the
  // webServer plugin's setup runs *before* globalSetup — by then the server
  // holds the file open, and unlinking it would leave the server writing to an
  // orphaned inode instead. See e2e-tests/reset-db.js; scripts/e2e-server.sh
  // runs the same step for the detached local server.
  webServer: [
    {
      command: process.env.E2E_DEV_SERVER
        ? `node e2e-tests/reset-db.js && npm run dev -- --port ${port}`
        : `node e2e-tests/reset-db.js && npm run build && npm start -- --port ${port}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 300 * 1000, // 5 minutes — a cold production build is included
      // Shared with scripts/e2e-server.sh — see e2e-tests/env.js.
      env: { PORT: port, ...e2eServerEnv },
    },
    // The bucket the app's presigned URLs point at. Playwright owns its
    // lifetime rather than scripts/e2e-server.sh, because unlike the database
    // it holds nothing worth carrying between runs — every object in it is
    // named by the hash of bytes a single test invented.
    {
      command: `node e2e-tests/fake-s3.js ${E2E_S3_PORT}`,
      url: `http://localhost:${E2E_S3_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
    },
  ],
});
