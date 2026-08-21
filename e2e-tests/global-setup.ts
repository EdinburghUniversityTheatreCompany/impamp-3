import { request } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_SIGNIN_SECRET } from "./env";

/**
 * Claim the admin account before any worker starts.
 *
 * `upsertUserFromGoogle` makes the first user ever written to the database an
 * admin and nothing grants it afterwards, so "an admin" is a property of
 * sign-in order rather than something a test can ask for. Which spec signs in
 * first depends on the worker count, the filter and the shard, so before this
 * the admin bit landed on an arbitrary throwaway account and the admin surface
 * could only ever be asserted from below its 404 boundary.
 *
 * Runs after the web servers are up — Playwright starts those first — and its
 * one job is to be the first request that creates a user.
 *
 * Idempotent against a reused server: on a second run the account already
 * exists and is already the admin, and `/api/test/session` hands back a fresh
 * token for it.
 */
export default async function globalSetup(): Promise<void> {
  const port = process.env.E2E_PORT ?? "3000";
  const context = await request.newContext({
    baseURL: `http://localhost:${port}`,
  });

  try {
    const response = await context.post("/api/test/session", {
      headers: { "x-impamp-e2e-secret": E2E_SIGNIN_SECRET },
      data: { email: E2E_ADMIN_EMAIL },
    });

    if (!response.ok()) {
      throw new Error(
        `test sign-in route answered ${response.status()} — is IMPAMP_E2E_SIGNIN_SECRET set on the server?`,
      );
    }

    const { user } = await response.json();
    if (!user.isAdmin) {
      // Loud, and worth being loud about: it means something wrote a user to
      // this database before global setup ran, so the database was not the
      // fresh one `reset-db.js` makes. Every admin assertion downstream would
      // otherwise fail one at a time with an unrelated-looking 404.
      throw new Error(
        `${E2E_ADMIN_EMAIL} is not the admin, so this database already had users in it. ` +
          `Restart the E2E server (scripts/e2e-server.sh) to reset it.`,
      );
    }
  } finally {
    await context.dispose();
  }
}
