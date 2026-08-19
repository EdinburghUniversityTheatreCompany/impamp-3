/**
 * A reorder writes `pageIndex` on the banks that moved and touches nothing
 * else. No pad row moves, no unique index is stressed, and identity is kept,
 * so the merge sees a position change rather than a mass rename.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  ensureDefaultBanks,
  getAllPageMetadataForProfile,
  reorderBanks,
  upsertPadConfiguration,
  getPadConfigurationsForProfileBank,
  renameBank,
  setBankEmergencyState,
} = await import("./db");

let profileId: number;

/** The bank ids in stored position order. */
async function order(): Promise<string[]> {
  const banks = await getAllPageMetadataForProfile(profileId);
  return banks
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((bank) => bank.bankId);
}

/**
 * Waits for the clock to move on.
 *
 * The stamps are `Date.now()` and `ensureDefaultBanks` already stamps every
 * field of every default bank — including `pageIndex` — at creation. So a
 * bank that a reorder leaves alone does *not* start from an absent stamp; the
 * only way to tell "untouched" from "touched but landed on the same
 * millisecond" is to let real time move past the creation stamp first. See
 * `googleDrive/dataAccess.stamps.test.ts` for the same pattern.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() <= start) await new Promise((r) => setTimeout(r, 1));
}

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
  await ensureDefaultBanks(profileId);
});

describe("reorderBanks", () => {
  it("moves a bank to the right", async () => {
    const before = await order();

    await reorderBanks(profileId, ["1", "2", "0", ...before.slice(3)]);

    expect((await order()).slice(0, 3)).toEqual(["1", "2", "0"]);
  });

  it("moves a bank to the left", async () => {
    const before = await order();

    await reorderBanks(profileId, ["4", ...before.filter((id) => id !== "4")]);

    expect((await order())[0]).toBe("4");
  });

  it("keeps the positions dense", async () => {
    const before = await order();

    await reorderBanks(profileId, [...before].reverse());

    const banks = await getAllPageMetadataForProfile(profileId);
    expect(banks.map((bank) => bank.pageIndex).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("writes nothing when the order does not change", async () => {
    const before = await getAllPageMetadataForProfile(profileId);
    const stamps = new Map(before.map((bank) => [bank.bankId, bank._modified]));

    await reorderBanks(profileId, await order());

    const after = await getAllPageMetadataForProfile(profileId);
    for (const bank of after) {
      expect(bank._modified).toBe(stamps.get(bank.bankId));
    }
  });

  it("stamps only the banks that moved", async () => {
    const before = await order();
    const untouched = before.slice(3);
    // `ensureDefaultBanks` already stamped every bank's `pageIndex` at
    // creation, so "untouched" is proven by an unchanged stamp, not an
    // absent one — capture the creation-time stamps to compare against.
    const beforeBanks = await getAllPageMetadataForProfile(profileId);
    const stampBefore = new Map(
      beforeBanks.map((bank) => [bank.bankId, bank._fieldsModified?.pageIndex]),
    );
    await nextMillisecond();

    await reorderBanks(profileId, ["1", "2", "0", ...untouched]);

    const after = await getAllPageMetadataForProfile(profileId);
    const byId = new Map(after.map((bank) => [bank.bankId, bank]));
    for (const bankId of ["0", "1", "2"]) {
      expect(byId.get(bankId)?._fieldsModified?.pageIndex).toBeGreaterThan(
        stampBefore.get(bankId) ?? 0,
      );
    }
    for (const bankId of untouched) {
      expect(byId.get(bankId)?._fieldsModified?.pageIndex).toBe(
        stampBefore.get(bankId),
      );
    }
  });

  it("leaves the pads, the names and the emergency flags alone", async () => {
    await renameBank(profileId, "0", "Stings");
    await setBankEmergencyState(profileId, "0", true);
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 5,
      name: "Horn",
      audioFileIds: [11],
      playbackType: "sequential",
    });
    const before = await order();

    await reorderBanks(profileId, [...before].reverse());

    const pads = await getPadConfigurationsForProfileBank(profileId, "0");
    const banks = await getAllPageMetadataForProfile(profileId);
    const moved = banks.find((bank) => bank.bankId === "0");
    expect(pads).toHaveLength(1);
    expect(pads[0].name).toBe("Horn");
    expect(moved?.name).toBe("Stings");
    expect(moved?.isEmergency).toBe(true);
  });

  it("ignores an id the profile does not hold", async () => {
    const before = await order();

    await reorderBanks(profileId, ["ghost", ...before]);

    expect(await order()).toEqual(before);
  });

  it("appends a bank the caller did not name", async () => {
    await reorderBanks(profileId, ["9", "8"]);

    const after = await order();
    expect(after.slice(0, 2)).toEqual(["9", "8"]);
    expect(after).toHaveLength(10);
  });
});
