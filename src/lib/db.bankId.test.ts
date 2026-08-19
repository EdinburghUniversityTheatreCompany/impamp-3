/**
 * A pad names its bank by identity, not by position. These are the reads and
 * writes that a reorder must leave alone.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  addProfile,
  upsertPadConfiguration,
  getPadConfigurationsForProfileBank,
  swapPadConfigurations,
  getDb,
  findMissingAudioFiles,
} = await import("./db");

// `upsertPageMetadata` still keys on the retired pageIndex-based
// "profilePage" index (that helper is Task 5's scope, not this task's), so
// tests here seed pageMetadata directly through the low-level store instead
// of routing through it.
async function addBank(
  profileIdArg: number,
  bankId: string,
  pageIndex: number,
  name: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.add("pageMetadata", {
    profileId: profileIdArg,
    bankId,
    pageIndex,
    name,
    isEmergency: false,
    createdAt: now,
    updatedAt: now,
  });
}

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
});

describe("pads keyed by bank identity", () => {
  it("reads back the pads of one bank and no others", async () => {
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 1,
      audioFileIds: [11],
      playbackType: "sequential",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "stings",
      padIndex: 1,
      audioFileIds: [22],
      playbackType: "sequential",
    });

    const pads = await getPadConfigurationsForProfileBank(profileId, "0");

    expect(pads).toHaveLength(1);
    expect(pads[0].audioFileIds).toEqual([11]);
  });

  it("updates the pad already at that bank and pad index", async () => {
    const first = await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 2,
      audioFileIds: [11],
      playbackType: "sequential",
    });
    const second = await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 2,
      name: "Renamed",
      audioFileIds: [11],
      playbackType: "sequential",
    });

    // Assert against the id the store handed back, never a literal: the
    // autoIncrement counter keeps climbing across the suite.
    expect(second).toBe(first);
    const pads = await getPadConfigurationsForProfileBank(profileId, "0");
    expect(pads).toHaveLength(1);
    expect(pads[0].name).toBe("Renamed");
  });

  it("swaps two pads inside one bank", async () => {
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      audioFileIds: [11],
      playbackType: "sequential",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 1,
      name: "Rain",
      audioFileIds: [22],
      playbackType: "sequential",
    });

    await swapPadConfigurations(profileId, "0", 0, 1);

    const pads = await getPadConfigurationsForProfileBank(profileId, "0");
    const byIndex = new Map(pads.map((pad) => [pad.padIndex, pad]));
    expect(byIndex.get(0)?.name).toBe("Rain");
    expect(byIndex.get(1)?.name).toBe("Horn");
  });
});

describe("findMissingAudioFiles across profiles that share a bankId", () => {
  it("reports each profile's own bank name, not another profile's", async () => {
    // Every profile migrated from the pre-bankId schema names its banks "0",
    // "1", "2", ... (the migration assigns migrated banks the deterministic
    // id String(pageIndex)), so two unrelated profiles both having a bank
    // whose bankId is "0" is the normal case, not an edge case.
    const profileA = await addProfile({ name: "Board A", syncType: "local" });
    const profileB = await addProfile({ name: "Board B", syncType: "local" });

    await addBank(profileA, "0", 0, "Bank A0");
    await addBank(profileB, "0", 0, "Bank B0");

    // Both pads reference an audio file id that was never stored, so both
    // show up as missing.
    await upsertPadConfiguration({
      profileId: profileA,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [999],
      playbackType: "sequential",
    });
    await upsertPadConfiguration({
      profileId: profileB,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [999],
      playbackType: "sequential",
    });

    const results = await findMissingAudioFiles();

    const rowA = results.find((row) => row.profileId === profileA);
    const rowB = results.find((row) => row.profileId === profileB);
    expect(rowA?.bankName).toBe("Bank A0");
    expect(rowB?.bankName).toBe("Bank B0");
  });
});
