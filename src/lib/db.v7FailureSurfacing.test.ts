/**
 * Regression test for an unhandled-promise-rejection bug on the V7
 * migration's abort-succeeds failure path.
 *
 * When `migrateToV7` rejects, the `upgrade` handler calls
 * `transaction.abort()` and rethrows. In the common case that abort
 * succeeds (there's nothing already committed to roll back), the
 * versionchange transaction aborts and `openDB()`'s own promise rejects
 * with that failure — which means the `.then(async (db) => ...)` callback
 * chained onto `openDB(...)` in `getDb()`, the only place that otherwise
 * awaits `v7MigrationOutcome`, never runs. Before the fix, that left
 * `v7MigrationOutcome`'s rejection with no handler at all: a real,
 * pre-commit V7 failure would still correctly reject `getDb()` (via
 * `openDB()`'s own rejection), but Node/Vitest would *also* report an
 * "Uncaught (in promise)" for the same error, which can fail an otherwise
 * green test file. The fix attaches a no-op `.catch` alongside the
 * assignment — see `src/lib/db.ts` around `v7MigrationOutcome = ...` — so
 * the rejection always has at least one handler, without changing what
 * `getDb()` itself resolves or rejects with.
 *
 * This forces that exact failure (a real, if artificial, `migrateToV7`
 * rejection) and asserts only that `getDb()` rejects as expected. The
 * defect this guards is process-level, not something `expect` can assert
 * on directly: if the fix regresses, this file's run reports an unhandled
 * rejection (Vitest fails the run with an "Unhandled Rejection" error)
 * even though the single `it` below still passes.
 */
import "@/lib/testSupport/browserGlobals";
import { describe, expect, it, vi } from "vitest";
import { openDB } from "idb";

vi.mock("@/lib/dbMigrations/v7BankId", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/dbMigrations/v7BankId")
  >("@/lib/dbMigrations/v7BankId");
  return {
    ...actual,
    migrateToV7: vi.fn(async () => {
      throw new Error("forced V7 migration failure for the regression test");
    }),
  };
});

const DB_NAME = "impamp3DB";

/** The shape a real device's database had at version 6, built by hand. */
async function seedV6Database(): Promise<void> {
  const seedDb = await openDB(DB_NAME, 6, {
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
  seedDb.close();
}

describe("a V7 migration failure on the abort-succeeds path", () => {
  it("rejects getDb() and leaves no unhandled rejection behind", async () => {
    await seedV6Database();

    const { getDb } = await import("@/lib/db");

    // `openDB()` itself is what `getDb()` returns to its caller, and once
    // `transaction.abort()` succeeds, the browser's own AbortError — not
    // `migrateToV7`'s original message — is what that promise rejects
    // with; the original error is only ever seen by `console.error`. The
    // one thing this test asserts on `expect` is simply that the failure
    // *does* surface as a rejected `getDb()` at all, matching whatever
    // IndexedDB reports for an aborted versionchange transaction.
    await expect(getDb()).rejects.toThrow("abort");
  });
});
