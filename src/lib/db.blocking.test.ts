/**
 * What an open connection does when another one needs to upgrade the schema.
 *
 * `DB_VERSION` is on 6 and has been bumped five times, so this fires for
 * anyone with ImpAmp open in two tabs — or an installed PWA plus a tab —
 * across a deploy that bumps it. The standard response to `blocking` is to
 * close the connection; this one only logged, so the old connection was never
 * released, the new tab's `openDB` never settled, and every consumer awaiting
 * `getDb()` — `ensureDefaultProfile`, the profile store's load,
 * `usePadConfigurations` — hung with no error and no UI. A blank soundboard
 * that a reload cannot fix while the first tab is open.
 *
 * One test, and it is the last thing this file does: it leaves the database at
 * a version `getDb()` cannot open again.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import "@/lib/testSupport/browserGlobals";
import { describe, expect, it } from "vitest";

const { getDb } = await import("@/lib/db");

describe("a schema upgrade arriving while this tab has the database open", () => {
  it("releases the connection so the upgrade can finish", async () => {
    const db = await getDb();
    const nextVersion = db.version + 1;

    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("impamp3DB", nextVersion);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open failed"));
      request.onblocked = () =>
        reject(
          new Error(
            "The upgrade was blocked: the existing connection never closed.",
          ),
        );
    });

    expect(upgraded.version).toBe(nextVersion);
    upgraded.close();
  });
});
