// Environment the E2E server must run with, in plain JS so that both the
// Playwright config (TypeScript) and scripts/e2e-server.sh (bash, via `node
// -p`) read the *same* values. They used to be defined only in
// playwright.config.ts, so a server started by e2e-server.sh ran against the
// developer's real database with the test sign-in route disabled — and every
// server-sync spec failed, whatever the app did.

import { resolve } from "node:path";

/** Throwaway server-sync database for the E2E run. Shared with the specs. */
export const E2E_DB_PATH = resolve(import.meta.dirname, "..", "data", "e2e.db");

/** Unlocks the test-only sign-in route for this run. */
export const E2E_SIGNIN_SECRET = "e2e-local-only-secret";

/**
 * The account the suite treats as the deployment's admin.
 *
 * Admin is not a flag anything can set: the *first* user ever written to the
 * database bootstraps as one, and no route grants it afterwards. So the only
 * way a test can have an admin is to be the first thing that signs in, which
 * is what `e2e-tests/global-setup.ts` exists to guarantee — it runs after the
 * server has started and before any worker does. Without it, whichever spec
 * happened to sign in first would silently own the admin bit, and which one
 * that is changes with the shard, the worker count and the filter.
 */
export const E2E_ADMIN_EMAIL = "e2e-admin@example.com";

/**
 * Where `e2e-tests/fake-s3.js` listens, and therefore what the app's presigned
 * URLs point at.
 *
 * Derived from the app's own port so a second checkout — a worktree on 3126,
 * say — brings its own bucket up alongside its own server instead of both
 * writing into one.
 */
export const E2E_S3_PORT = Number(process.env.E2E_PORT ?? 3000) + 70;

/**
 * What the server process needs in its environment, keyed as the app reads it.
 *
 * NEXT_PUBLIC_* are compiled in, so they matter at build time; the rest are
 * read at run time.
 */
export const e2eServerEnv = {
  // Compiles in the window hooks the suite reads internal state through
  // (see src/lib/testHooks.ts); a real deploy leaves this unset.
  NEXT_PUBLIC_E2E_HOOKS: "1",
  // Must be set for the production build to prerender. No test signs in to
  // Google, so a placeholder is enough.
  NEXT_PUBLIC_GOOGLE_CLIENT_ID:
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ??
    "e2e-placeholder.apps.googleusercontent.com",
  // Server sync writes to its own throwaway database during E2E, kept out of
  // the developer's ./data/impamp.db. server-sync.spec.ts opens the same file
  // directly to mint a session, which is the only way to sign in without a
  // real Google account.
  IMPAMP_DB_PATH: E2E_DB_PATH,
  // Enables /api/test/session, the suite's only way to sign in without a real
  // Google account. Unset everywhere else, so the route 404s.
  IMPAMP_E2E_SIGNIN_SECRET: E2E_SIGNIN_SECRET,

  // Hosted audio, pointed at e2e-tests/fake-s3.js. Setting all five is what
  // turns the feature on, and it stays gated per account behind
  // `can_upload_audio` — so an ordinary E2E account still cannot upload, and
  // the routes still refuse it. What this buys is the other half: the
  // presigned PUT, the commit that charges quota from what the bucket
  // reports, proof-of-possession and the download URL, none of which any
  // earlier E2E could reach.
  //
  // The credentials are nonsense on purpose. The fake bucket does not verify
  // signatures (`sigv4.test.ts` does that, against the specification's
  // vectors), and nothing here may look like something that would work
  // against a real endpoint.
  IMPAMP_S3_ENDPOINT: `http://localhost:${E2E_S3_PORT}`,
  IMPAMP_S3_REGION: "e2e-region",
  IMPAMP_S3_BUCKET: "e2e-bucket",
  IMPAMP_S3_ACCESS_KEY_ID: "e2e-not-a-real-key",
  IMPAMP_S3_SECRET_ACCESS_KEY: "e2e-not-a-real-secret",
  // Small enough that a test can reach the ceiling with a few kilobytes.
  IMPAMP_AUDIO_USER_QUOTA_BYTES: String(64 * 1024),
  IMPAMP_AUDIO_MAX_OBJECT_BYTES: String(32 * 1024),
};
