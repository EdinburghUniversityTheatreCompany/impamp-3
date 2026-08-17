import { assertDatabaseUsable } from "@/lib/server/db";

// Explicitly opt out of caching to ensure the healthcheck is always fresh.
export const dynamic = "force-dynamic";

/**
 * The health check Kamal promotes a container on.
 *
 * It used to return a constant, which meant it could not see the one failure
 * mode this deployment has actually hit. `getDb()` opens the file lazily on the
 * first request that needs it, so a container whose `/data` volume is
 * unwritable answered 200, was promoted, and then 500'd on the first sync. That
 * happened: the pre-existing `impamp_data` volume was root-owned while the
 * container now runs as uid 1000, and it took a human reading a plan and
 * running a manual chown to catch it before deploying.
 *
 * So it touches the database now — open it, take the write lock, let it go.
 * That stays cheap (the handle is memoised, and an empty transaction writes
 * nothing) and it cannot flake: node:sqlite is synchronous and Node is
 * single-threaded, so nothing else can be holding the lock while this runs.
 */
export function GET() {
  try {
    assertDatabaseUsable();
  } catch (error) {
    console.error("Health check failed: the database is not usable:", error);
    return new Response("database unavailable", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response("OK", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
