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
};
