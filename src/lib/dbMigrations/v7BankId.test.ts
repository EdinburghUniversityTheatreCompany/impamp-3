/**
 * The v7 migration rewrites every pad row and every bank row, so it gets
 * direct tests against a database built in the v6 shape.
 *
 * The three properties that matter are in the spec: a pad at a position with
 * no bank row gains one and keeps its sounds; a second run changes nothing;
 * and two devices that migrate the same data mint the same ids, so the merge
 * sees one set of banks rather than two. Two more scenarios are seeded
 * alongside those: a second profile whose pads sit only at a non-zero
 * position with no bank row at position 0 (the "changes nothing on a second
 * run" case is otherwise blind to a regression in pass 1's idempotency
 * guard — a stripped pad's fallback position happens to already have a row
 * when there's only one profile), and a pad with no `pageIndex` at all
 * (corrupt data pass 1 and pass 3 both explicitly refuse to place).
 *
 * The second `describe` covers pass 4, the post-migration invariant check.
 * Those tests can't reach their failure states by seeding data — the passes
 * are correct, which is the point — so they sabotage one store operation
 * each and assert the migration refuses to commit, with a message that says
 * which invariant failed and with what numbers.
 */

// Must be the first import: it installs fake-indexeddb before `idb` opens
// anything.
import "@/lib/testSupport/browserGlobals";
import { describe, expect, it, vi } from "vitest";
import { openDB } from "idb";
import { migrateToV7, migratedBankId, type V7Transaction } from "./v7BankId";

let databaseCounter = 0;
const nextName = () => `v7-migration-test-${++databaseCounter}`;

/** Builds a database in the v6 shape and seeds it. */
async function seedV6(name: string) {
  const db = await openDB(name, 6, {
    upgrade(database) {
      const pads = database.createObjectStore("padConfigurations", {
        keyPath: "id",
        autoIncrement: true,
      });
      pads.createIndex("profileId", "profileId");
      pads.createIndex(
        "profilePagePad",
        ["profileId", "pageIndex", "padIndex"],
        { unique: true },
      );
      const pages = database.createObjectStore("pageMetadata", {
        keyPath: "id",
        autoIncrement: true,
      });
      pages.createIndex("profileId", "profileId");
      pages.createIndex("profilePage", ["profileId", "pageIndex"], {
        unique: true,
      });
    },
  });

  // Bank 1 has a row. Bank 3 has pads and no row at all, which is what the
  // page component used to paper over.
  await db.add("pageMetadata", {
    profileId: 1,
    pageIndex: 0,
    name: "Stings",
    isEmergency: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await db.add("padConfigurations", {
    profileId: 1,
    pageIndex: 0,
    padIndex: 4,
    name: "Horn",
    audioFileIds: [11],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await db.add("padConfigurations", {
    profileId: 1,
    pageIndex: 2,
    padIndex: 7,
    name: "Rain",
    audioFileIds: [22],
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  // A second profile, with pads only at a non-zero position and no bank row
  // at position 0 (or anywhere). Pass 1's `if (pad.bankId) continue` guard
  // is only exercised meaningfully when the fallback position a *broken*
  // guard would compute (`pageIndex ?? 0`) doesn't already have a row from
  // something else — profile 1 above always has one at position 0, which
  // would mask a regression here. See "changes nothing on a second run".
  await db.add("padConfigurations", {
    profileId: 2,
    pageIndex: 3,
    padIndex: 1,
    name: "Wind",
    audioFileIds: [33],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  // Corrupt data: a pad with neither `bankId` nor `pageIndex`. Nothing in
  // this schema's history produces this on purpose, but the migration has
  // to do *something* sane with it rather than silently defaulting it into
  // a real bank. See "skips a pad with no pageIndex".
  await db.add("padConfigurations", {
    profileId: 1,
    padIndex: 9,
    name: "Ghost",
    audioFileIds: [99],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  db.close();
  return name;
}

/**
 * Opens the seeded database at the given version and runs the migration,
 * awaiting its outcome before returning. Awaiting matters: without it, a
 * rejecting `migrateToV7` surfaces as an unhandled rejection instead of a
 * normal, readable assertion failure in whichever `it` block triggered it.
 */
async function migrate(name: string, version: number) {
  let migrationDone: Promise<void> | undefined;
  const db = await openDB(name, version, {
    upgrade(_database, _oldVersion, _newVersion, transaction) {
      migrationDone = migrateToV7(transaction as unknown as V7Transaction);
    },
  });
  await migrationDone;
  return db;
}

describe("the v7 bank identity migration", () => {
  it("gives every pad the bank id of its old position", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    const pads = await db.getAll("padConfigurations");
    const horn = pads.find((pad) => pad.name === "Horn");
    const rain = pads.find((pad) => pad.name === "Rain");

    expect(horn?.bankId).toBe(migratedBankId(0));
    expect(rain?.bankId).toBe(migratedBankId(2));
    db.close();
  });

  it("drops the pad's own copy of the position", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    const pads = await db.getAll("padConfigurations");

    // `.toEqual([])` over `.every(...).toBe(true)`: on failure this names
    // the offending rows instead of just reporting "expected false to be
    // true".
    expect(pads.filter((pad) => "pageIndex" in pad)).toEqual([]);
    db.close();
  });

  it("creates a bank row for a position that had pads but no row", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    const pages = await db.getAll("pageMetadata");
    const created = pages.find((page) => page.pageIndex === 2);

    expect(created?.bankId).toBe(migratedBankId(2));
    // The name the upsert helper would have given it: bank *numbers* are
    // 1-based, so position 2 is "Bank 3".
    expect(created?.name).toBe("Bank 3");
    expect(created?.isEmergency).toBe(false);
    db.close();
  });

  it("keeps the name and the emergency flag of a bank that had a row", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    const pages = await db.getAll("pageMetadata");
    const stings = pages.find((page) => page.name === "Stings");

    expect(stings?.bankId).toBe(migratedBankId(0));
    expect(stings?.isEmergency).toBe(true);
    db.close();
  });

  it("replaces the two position indexes with identity indexes", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    const padIndexes = [
      ...db.transaction("padConfigurations").store.indexNames,
    ];
    const pageIndexes = [...db.transaction("pageMetadata").store.indexNames];

    expect(padIndexes).toContain("profileBankPad");
    expect(padIndexes).not.toContain("profilePagePad");
    expect(pageIndexes).toContain("profileBank");
    expect(pageIndexes).not.toContain("profilePage");
    db.close();
  });

  it("skips a pad with no pageIndex, warns once, and invents no bank for it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const db = await migrate(await seedV6(nextName()), 7);

    const pads = await db.getAll("padConfigurations");
    const ghost = pads.find((pad) => pad.name === "Ghost");
    expect(ghost?.bankId).toBeUndefined();

    const pages = await db.getAll("pageMetadata");
    // Profile 1 already owns exactly two real banks from its other seeded
    // pads (Stings at position 0, materialised "Bank 3" at position 2). An
    // unplaceable pad must not add a third — that would mean it silently
    // fell back to some default position instead of being left unmigrated.
    expect(pages.filter((page) => page.profileId === 1)).toHaveLength(2);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("neither bankId nor pageIndex"),
    );

    warnSpy.mockRestore();
    db.close();
  });

  it("changes nothing on a second run", async () => {
    const name = await seedV6(nextName());
    const first = await migrate(name, 7);
    const afterFirst = {
      pads: await first.getAll("padConfigurations"),
      pages: await first.getAll("pageMetadata"),
    };
    first.close();

    // Version 8 re-runs the same code over already migrated rows.
    const second = await migrate(name, 8);
    const afterSecond = {
      pads: await second.getAll("padConfigurations"),
      pages: await second.getAll("pageMetadata"),
    };
    second.close();

    expect(afterSecond).toEqual(afterFirst);
  });

  it("mints the same ids on two devices, so a merge sees one set of banks", async () => {
    const deviceA = await migrate(await seedV6(nextName()), 7);
    const deviceB = await migrate(await seedV6(nextName()), 7);

    const idsOf = async (db: typeof deviceA) =>
      (await db.getAll("pageMetadata"))
        .map((page) => page.bankId as string)
        .sort();

    const a = await idsOf(deviceA);
    const b = await idsOf(deviceB);

    expect(a).toEqual(b);
    // The merge keys on identity, so one set of banks, not two.
    expect(new Set([...a, ...b]).size).toBe(a.length);
    deviceA.close();
    deviceB.close();
  });
});

/**
 * The subset of an object store `migrateToV7` actually touches. The
 * sabotage harness below stands in for a real store, so it has to offer
 * exactly this much and no more.
 */
interface WritableStore {
  readonly indexNames: DOMStringList;
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: IDBIndexParameters,
  ): unknown;
  deleteIndex(name: string): void;
  add(value: Row): Promise<unknown>;
  put(value: Row): Promise<unknown>;
  delete(key: number): Promise<void>;
  getAll(): Promise<Row[]>;
}

type Row = Record<string, unknown>;

interface StoreSabotage {
  /**
   * Rewrites the record a `put` is about to write. Returning `null` deletes
   * the row instead, which is how a pad gets lost.
   */
  put?: (record: Row) => Row | null;
  /**
   * Rewrites what a `getAll()` returns. `call` is 1-based: call 1 is the
   * snapshot at the top of the migration, call 2 is pass 4 reading the
   * stores back. Doctoring call 2 only is what lets a test show pass 4
   * rejecting a state the real stores refuse to hold (see the duplicate
   * identity test).
   */
  getAll?: (rows: Row[], call: number) => Row[];
}

type Sabotage = Partial<
  Record<"padConfigurations" | "pageMetadata", StoreSabotage>
>;

/** Wraps a versionchange transaction so one store operation misbehaves. */
function sabotageTransaction(
  transaction: { objectStore(name: string): unknown },
  sabotage: Sabotage,
): V7Transaction {
  const wrapped = new Map<string, WritableStore>();
  const target = {
    objectStore(name: string): WritableStore {
      const cached = wrapped.get(name);
      // Cached because the `getAll` call counter has to survive across the
      // migration's two reads of the same store handle.
      if (cached) return cached;
      const real = transaction.objectStore(name) as unknown as WritableStore;
      const hooks = sabotage[name as keyof Sabotage] ?? {};
      let getAllCalls = 0;
      const store: WritableStore = {
        get indexNames() {
          return real.indexNames;
        },
        createIndex: (indexName, keyPath, options) =>
          real.createIndex(indexName, keyPath, options),
        deleteIndex: (indexName) => real.deleteIndex(indexName),
        add: (value) => real.add(value),
        delete: (key) => real.delete(key),
        put: async (value) => {
          const replacement = hooks.put ? hooks.put(value) : value;
          if (replacement === null) return real.delete(value.id as number);
          return real.put(replacement);
        },
        getAll: async () => {
          getAllCalls += 1;
          const rows = await real.getAll();
          return hooks.getAll ? hooks.getAll(rows, getAllCalls) : rows;
        },
      };
      wrapped.set(name, store);
      return store;
    },
  };
  return target as unknown as V7Transaction;
}

/**
 * Runs the migration over a freshly seeded database with one store
 * operation sabotaged, and returns the error it refused to commit with.
 */
async function migrateSabotaged(sabotage: Sabotage): Promise<Error> {
  const name = await seedV6(nextName());
  let migrationDone: Promise<void> | undefined;
  const db = await openDB(name, 7, {
    upgrade(_database, _oldVersion, _newVersion, transaction) {
      migrationDone = migrateToV7(
        sabotageTransaction(
          transaction as unknown as { objectStore(store: string): unknown },
          sabotage,
        ),
      );
      // The same no-op handler `db.ts` attaches beside `v7MigrationOutcome`,
      // and for the same reason: the migration rejects during `upgrade`,
      // which is before `openDB()` resolves and the `await` below can
      // attach. Without this the run reports an unhandled rejection for an
      // error the test goes on to assert on. A promise broadcasts to every
      // handler, so this doesn't consume it.
      migrationDone.catch(() => {});
    },
  });
  let thrown: unknown;
  try {
    await migrationDone;
  } catch (error) {
    thrown = error;
  }
  db.close();
  if (!(thrown instanceof Error)) {
    throw new Error(
      "the migration was expected to reject and did not; the invariant check did not fire",
    );
  }
  return thrown;
}

describe("the v7 migration's post-migration invariant check", () => {
  // Every seeded profile carries the unplaceable "Ghost" pad, so each of
  // these also demonstrates that the skipped row is not what tripped the
  // check.
  it("refuses to commit if a pad row was lost", async () => {
    const error = await migrateSabotaged({
      padConfigurations: { put: (pad) => (pad.name === "Rain" ? null : pad) },
    });

    expect(error.message).toContain(
      "pad rows changed in number - 4 before, 3 after.",
    );
    // Every message ends with why throwing is the safe move here.
    expect(error.message).toContain("stays at version 6 with its data intact");
  });

  it("refuses to commit if a placeable pad got no bankId", async () => {
    const error = await migrateSabotaged({
      padConfigurations: {
        put: (pad) => {
          if (pad.name !== "Rain") return pad;
          const { bankId: _dropped, ...rest } = pad;
          return rest;
        },
      },
    });

    // Three of the four seeded pads are placeable; the fourth is Ghost,
    // and the message has to say so rather than counting it as a loss.
    expect(error.message).toContain(
      "2 of 4 pads carry a bankId, but 3 should (the other 1 had neither bankId nor pageIndex and were skipped on purpose).",
    );
  });

  it("refuses to commit if a pad names a bank that does not exist", async () => {
    const error = await migrateSabotaged({
      padConfigurations: {
        put: (pad) => (pad.name === "Rain" ? { ...pad, bankId: "97" } : pad),
      },
    });

    expect(error.message).toContain(
      "1 of 4 pads name a bank that does not exist",
    );
    expect(error.message).toContain('names bankId "97".');
  });

  it("refuses to commit if two bank rows share an identity", async () => {
    // Doctoring pass 4's read, not the stores: the `profileBank` index is
    // unique, so a real duplicate is refused by IndexedDB long before pass
    // 4 sees it. This check exists for the edit that changes that index,
    // and this is the only way to show it working.
    const error = await migrateSabotaged({
      pageMetadata: {
        getAll: (rows, call) => (call === 2 ? [...rows, { ...rows[0] }] : rows),
      },
    });

    expect(error.message).toContain(
      'two bank rows share the identity (profile 1, bankId "0") - 4 bank rows carry only 3 distinct identities.',
    );
  });

  it("refuses to commit if a bank row has no identity at all", async () => {
    const error = await migrateSabotaged({
      pageMetadata: {
        getAll: (rows, call) => {
          if (call !== 2) return rows;
          const [first, ...rest] = rows;
          const { bankId: _dropped, ...stripped } = first;
          return [stripped, ...rest];
        },
      },
    });

    expect(error.message).toContain("on profile 1 at position 0 has no bankId");
    expect(error.message).toContain("out of 3 bank rows.");
  });

  it("refuses to commit if a bank row was lost", async () => {
    const error = await migrateSabotaged({
      pageMetadata: { getAll: (rows, call) => (call === 2 ? [] : rows) },
    });

    expect(error.message).toContain("bank rows were lost - 1 before, 0 after.");
  });

  it("does not fire on the happy path, unplaceable pad and all", async () => {
    const db = await migrate(await seedV6(nextName()), 7);

    // The check passed, so the seeded profiles migrated in full: the three
    // placeable pads are stamped and every one of them resolves to a bank
    // row that exists. One corrupt row aborting all of that is exactly what
    // pass 1's skip-with-a-warning decision refuses to do.
    const pads = await db.getAll("padConfigurations");
    const pages = await db.getAll("pageMetadata");
    const identities = new Set(
      pages.map((page) => `${page.profileId}:${page.bankId}`),
    );

    expect(pads).toHaveLength(4);
    const placed = pads.filter((pad) => pad.bankId);
    expect(placed.map((pad) => pad.name).sort()).toEqual([
      "Horn",
      "Rain",
      "Wind",
    ]);
    for (const pad of placed) {
      expect(identities).toContain(`${pad.profileId}:${pad.bankId}`);
    }
    db.close();
  });
});
