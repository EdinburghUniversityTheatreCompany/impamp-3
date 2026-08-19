/**
 * Regression test for the V4/V7 upgrade race in `getDb`'s upgrade handler.
 *
 * The V4 cursor pass and the V7 migration both walk `padConfigurations` and
 * `pageMetadata` inside the same versionchange transaction. Before the fix,
 * the V7 block issued its `getAll()` in the same synchronous tick as V4's
 * `openCursor()` calls; IndexedDB processes requests in placement order, so
 * V7 snapshotted pre-V4 data and then interleaved writes with V4's cursor
 * with no defined winner. Any database sitting at `oldVersion < 4` (which
 * includes a real, if rare, version-3 database) lost pad data upgrading
 * straight to v7: some pads never got `bankId` and vanished from their
 * bank, and — for a genuinely pre-V3 database — some never got their
 * `audioFileId` converted to `audioFileIds` and lost their sound.
 *
 * This seeds a raw, unmigrated version-3 database by hand — not through
 * `getDb()`, which always opens at the current `DB_VERSION` — and then lets
 * the real `getDb()` run its actual v3 -> v7 upgrade path.
 */
import "@/lib/testSupport/browserGlobals";
import { describe, expect, it } from "vitest";
import { openDB } from "idb";

const DB_NAME = "impamp3DB";
const PROFILE_ID = 1;

/** The shape a real device's database had at version 3, built by hand. */
async function seedV3Database(): Promise<void> {
  const seedDb = await openDB(DB_NAME, 3, {
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

  const now = new Date();
  const tx = seedDb.transaction(
    ["padConfigurations", "pageMetadata"],
    "readwrite",
  );
  const padStore = tx.objectStore("padConfigurations");
  const pageStore = tx.objectStore("pageMetadata");

  // One explicit bank at position 0. Position 5 gets no row at all — the
  // implicit-bank case page.tsx used to synthesise client-side — so the
  // race is exercised on both the "stamp an existing bank" path and the
  // "materialise a missing one" path.
  await pageStore.add({
    profileId: PROFILE_ID,
    pageIndex: 0,
    name: "Bank 1",
    isEmergency: false,
    createdAt: now,
    updatedAt: now,
  });

  for (const pageIndex of [0, 5]) {
    for (let padIndex = 0; padIndex < 3; padIndex++) {
      await padStore.add({
        profileId: PROFILE_ID,
        pageIndex,
        padIndex,
        audioFileIds: [1],
        playbackType: "sequential",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  await tx.done;
  seedDb.close();
}

describe("upgrading a v3 database straight to v7", () => {
  it("leaves every pad with both audioFileIds and bankId, with no data loss", async () => {
    await seedV3Database();

    const { getDb } = await import("@/lib/db");
    const db = await getDb();

    const pads = await db.getAll("padConfigurations");
    const pages = await db.getAll("pageMetadata");

    expect(pads).toHaveLength(6);
    for (const pad of pads) {
      expect(pad.audioFileIds).toEqual([1]);
      expect(typeof pad.bankId).toBe("string");
      expect(pad.bankId.length).toBeGreaterThan(0);
    }

    const bankIdByPosition = new Map(
      pages.map((page) => [page.pageIndex, page.bankId]),
    );
    expect(bankIdByPosition.get(0)).toBe("0");
    expect(bankIdByPosition.get(5)).toBe("5");

    const padBankIds = new Set(pads.map((pad) => pad.bankId));
    expect(padBankIds).toEqual(new Set(["0", "5"]));

    // No spurious duplicate bank materialised for position 0, which already
    // had a row before the upgrade.
    expect(pages.filter((page) => page.pageIndex === 0)).toHaveLength(1);
    expect(pages.filter((page) => page.pageIndex === 5)).toHaveLength(1);
  });
});
