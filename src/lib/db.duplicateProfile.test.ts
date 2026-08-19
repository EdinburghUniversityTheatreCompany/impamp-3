/**
 * `duplicateProfileLocally` — "Duplicate" in the profile manager.
 *
 * It hand-copies the pad fields it knows about, and `extractPadPlaybackSettings`
 * exists twelve lines above it precisely to stop anyone doing that: its
 * docstring says the trigger arguments used to be hand-copied at roughly ten
 * call sites, every field is optional, so missing one produces no compiler
 * error — just a pad that plays at the wrong level.
 *
 * `swapPadConfigurations` uses the helper. This function, written later, does
 * not, and drops both gain fields on the floor. Nothing covered it.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  duplicateProfileLocally,
  addProfile,
  upsertPadConfiguration,
  upsertPageMetadata,
  getPadConfigurationsForProfileBank,
  getProfile,
} = await import("./db");

let sourceProfileId: number;

beforeEach(async () => {
  await clearAllStores();

  sourceProfileId = await addProfile({
    name: "Original",
    syncType: "local",
    activePadBehavior: "restart",
    normalisation: { enabled: true, targetLufs: -18 },
    backupReminderPeriod: 12_345,
  });

  // A bank the source's pad belongs to, so the duplicate has an identity to
  // carry across — without this, `getAllPageMetadataForProfile` returns
  // nothing for either profile and the bank-identity test below could never
  // observe a regression.
  await upsertPageMetadata({
    profileId: sourceProfileId,
    bankId: "0",
    pageIndex: 0,
    name: "Bank 1",
  });

  await upsertPadConfiguration({
    profileId: sourceProfileId,
    bankId: "0",
    padIndex: 3,
    keyBinding: "q",
    name: "Horn",
    audioFileIds: [11, 22],
    playbackType: "sequential",
    isDisabled: true,
    audioTrimSettings: { 11: { trimStart: 0.5, trimEnd: 2 } },
    // The two fields the copy dropped.
    audioGainSettings: { 11: -6, 22: 3 },
    padGainDb: -2.5,
  });
});

async function duplicatedPad() {
  const newId = await duplicateProfileLocally(sourceProfileId, "Copy");
  const pads = await getPadConfigurationsForProfileBank(newId, "0");
  return { newId, pad: pads.find((p) => p.padIndex === 3) };
}

describe("duplicating a profile", () => {
  it("carries the per-sound gain settings", async () => {
    // The copy references the same audio rows, so the ids these are keyed by
    // still mean the same sounds — the same reasoning the trim settings were
    // copied under.
    const { pad } = await duplicatedPad();

    expect(pad?.audioGainSettings).toEqual({ 11: -6, 22: 3 });
  });

  it("carries the per-pad gain", async () => {
    const { pad } = await duplicatedPad();

    expect(pad?.padGainDb).toBe(-2.5);
  });

  it("still carries everything it already carried", async () => {
    const { pad } = await duplicatedPad();

    expect(pad?.name).toBe("Horn");
    expect(pad?.keyBinding).toBe("q");
    expect(pad?.audioFileIds).toEqual([11, 22]);
    expect(pad?.playbackType).toBe("sequential");
    expect(pad?.isDisabled).toBe(true);
    expect(pad?.audioTrimSettings).toEqual({
      11: { trimStart: 0.5, trimEnd: 2 },
    });
  });

  it("carries the profile's own normalisation and reminder settings", async () => {
    const { newId } = await duplicatedPad();
    const copy = await getProfile(newId);

    // A duplicate that normalises differently from its original sounds
    // different, which is the one thing a duplicate must not do.
    expect(copy?.normalisation).toEqual({ enabled: true, targetLufs: -18 });
    expect(copy?.backupReminderPeriod).toBe(12_345);
    expect(copy?.activePadBehavior).toBe("restart");
  });

  it("does not link the copy to wherever the original synced", async () => {
    const { newId } = await duplicatedPad();
    const copy = await getProfile(newId);

    expect(copy?.syncType).toBe("local");
    expect(copy?.name).toBe("Copy");
  });

  it("copies the bank identities, so the tab order survives", async () => {
    const { newId } = await duplicatedPad();
    const { getAllPageMetadataForProfile } = await import("./db");

    const banks = await getAllPageMetadataForProfile(newId);

    expect(banks.map((bank) => bank.bankId)).toContain("0");
  });
});
