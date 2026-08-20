/**
 * The pre-v7 IndexedDB shape, built by hand.
 *
 * Two migration suites need a database that a real device actually had — one
 * at version 2 (`db.v7Sequencing.test.ts`, for the V4/V7 upgrade race) and one
 * at version 6 (`db.v7FailureSurfacing.test.ts`, for the abort-succeeds
 * failure path). Neither can use `getDb()`, which always opens at the current
 * `DB_VERSION` and so never exercises an upgrade from anywhere else.
 *
 * The stores and indexes below are identical for both, and were identical in
 * both files before this helper existed. That is what made them a duplicate
 * block big enough to fail the jscpd gate — the honest fix for which is one
 * copy, not a suppression pragma. The `version` is the only thing that varies,
 * and it varies for a reason each caller documents.
 *
 * Note that `profilePagePad` and `profilePage` are the *old* index names,
 * which is the whole point: `migrateToV7` is what replaces them with
 * `profileBankPad` and `profileBank`.
 */

// Must come first: it installs `window` and fake-indexeddb before anything
// below can reach for either. Callers import it first too; this is belt and
// braces so the helper is safe to import in any order.
import "./browserGlobals";
import { openDB, type IDBPDatabase } from "idb";

export const DB_NAME = "impamp3DB";

/**
 * Creates `impamp3DB` at a legacy version, with the v2-to-v6 schema.
 *
 * @param version - The version to stop at, which decides which of `db.ts`'s
 *   migration blocks the following `getDb()` will run
 * @returns The open connection, so a caller can seed rows into it. The caller
 *   closes it.
 */
export async function openLegacyDatabase(
  version: number,
): Promise<IDBPDatabase> {
  return openDB(DB_NAME, version, {
    upgrade(db) {
      db.createObjectStore("profiles", {
        keyPath: "id",
        autoIncrement: true,
      }).createIndex("name", "name", { unique: true });
      db.createObjectStore("audioFiles", {
        keyPath: "id",
        autoIncrement: true,
      }).createIndex("name", "name");
      const padStore = db.createObjectStore("padConfigurations", {
        keyPath: "id",
        autoIncrement: true,
      });
      padStore.createIndex("profileId", "profileId");
      padStore.createIndex(
        "profilePagePad",
        ["profileId", "pageIndex", "padIndex"],
        { unique: true },
      );
      const pageStore = db.createObjectStore("pageMetadata", {
        keyPath: "id",
        autoIncrement: true,
      });
      pageStore.createIndex("profileId", "profileId");
      pageStore.createIndex("profilePage", ["profileId", "pageIndex"], {
        unique: true,
      });
    },
  });
}
