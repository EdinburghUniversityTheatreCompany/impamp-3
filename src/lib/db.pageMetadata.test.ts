/**
 * Renaming a bank and flagging it as an emergency bank are separate edits and
 * must not undo one another.
 *
 * Both helpers used to read the record *outside* the write transaction and
 * then write back *both* fields, so each carried a stale copy of the other's:
 * whichever landed second reverted the first. Two people editing the same
 * profile is the ordinary case for this app, and so is one person toggling
 * emergency while a sync writes a rename.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  renameBank,
  setBankEmergencyState,
  getBankById,
  upsertPageMetadata,
  ensureDefaultBanks,
  createBank,
} = await import("./db");

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
  // Every profile starts with its ten default banks (see ensureDefaultBanks).
  // renameBank/setBankEmergencyState edit an existing bank and no longer
  // create one implicitly — that split is what "refuses to create a bank
  // without a position" below is guarding — so the fixture has to put bank
  // "0" there first, the same way the app wires a new profile up.
  await ensureDefaultBanks(profileId);
});

describe("editing bank metadata", () => {
  it("keeps the emergency flag when the bank is renamed", async () => {
    await setBankEmergencyState(profileId, "0", true);
    await renameBank(profileId, "0", "Act One");

    const bank = await getBankById(profileId, "0");
    expect(bank?.name).toBe("Act One");
    expect(bank?.isEmergency).toBe(true);
  });

  it("keeps the name when the emergency flag is toggled", async () => {
    await renameBank(profileId, "0", "Act Two");
    await setBankEmergencyState(profileId, "0", true);

    const bank = await getBankById(profileId, "0");
    expect(bank?.name).toBe("Act Two");
    expect(bank?.isEmergency).toBe(true);
  });

  it("does not let concurrent edits revert each other", async () => {
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Before",
      isEmergency: false,
    });

    await Promise.all([
      renameBank(profileId, "0", "After"),
      setBankEmergencyState(profileId, "0", true),
    ]);

    const bank = await getBankById(profileId, "0");
    expect(bank?.name).toBe("After");
    expect(bank?.isEmergency).toBe(true);
  });

  it("names a bank it has to create by its bank number, not its index", async () => {
    // bankId "10" and pageIndex 10 are both outside the ten defaults the
    // shared beforeEach already created, so this really does take the create
    // branch rather than merely updating an existing default bank.
    await upsertPageMetadata({ profileId, bankId: "10", pageIndex: 10 });

    expect((await getBankById(profileId, "10"))?.name).toBe("Bank 11");
  });

  it("refuses to create a bank without a position", async () => {
    await expect(
      upsertPageMetadata({ profileId, bankId: "new" }),
    ).rejects.toThrow(/position/i);
  });

  it("does not read another profile's bank of the same id", async () => {
    // bankId is unique per profile, not globally: the v7 migration and
    // ensureDefaultBanks both mint "0" for every profile's first bank, so
    // every profile on every device has a bank called "0". A lookup keyed on
    // bankId alone would return whichever profile's "0" it found first.
    const otherProfileId = await addProfile({
      name: "Other Board",
      syncType: "local",
    });
    await ensureDefaultBanks(otherProfileId);
    await renameBank(otherProfileId, "0", "Someone Else's Bank");

    const bank = await getBankById(profileId, "0");
    expect(bank?.name).not.toBe("Someone Else's Bank");
    expect(bank?.profileId).toBe(profileId);
  });
});

describe("the default banks", () => {
  it("creates ten banks with deterministic ids", async () => {
    const banks = await ensureDefaultBanks(profileId);

    expect(banks.map((bank) => bank.bankId)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(banks.map((bank) => bank.pageIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("creates nothing on a second call", async () => {
    const first = await ensureDefaultBanks(profileId);
    const second = await ensureDefaultBanks(profileId);

    expect(second.map((bank) => bank.id)).toEqual(first.map((bank) => bank.id));
  });

  it("keeps a renamed default bank", async () => {
    await ensureDefaultBanks(profileId);
    await renameBank(profileId, "3", "Interval");

    const banks = await ensureDefaultBanks(profileId);

    expect(banks.find((bank) => bank.bankId === "3")?.name).toBe("Interval");
  });
});

describe("createBank", () => {
  it("mints a random id and takes the first free position", async () => {
    await ensureDefaultBanks(profileId);

    const bank = await createBank(profileId, "Beds");

    expect(bank.pageIndex).toBe(10);
    expect(bank.name).toBe("Beds");
    // A bank created after the migration is safe with a random id, because
    // a creation is a synced event and cannot diverge.
    expect(bank.bankId).not.toBe("10");
    expect(bank.bankId.length).toBeGreaterThan(10);
  });

  it("refuses to pass the twenty-bank cap", async () => {
    await ensureDefaultBanks(profileId);
    for (let n = 0; n < 10; n++) {
      await createBank(profileId, `Extra ${n}`);
    }

    await expect(createBank(profileId, "One too many")).rejects.toThrow(
      /at most 20/,
    );
  });
});
