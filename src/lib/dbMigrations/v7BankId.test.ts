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
