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
} = await import("./db");

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
