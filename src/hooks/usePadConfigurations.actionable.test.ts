/**
 * Which pad configs a trigger is allowed to act on.
 *
 * `usePadConfigurations` hands back the previous bank's pads while the next
 * bank's read is in flight, deliberately, so the grid does not blank on every
 * bank change. `PadGrid` knew that and refused to act during the window;
 * `useKeyboardListener` consumed the same hook without the guard, so a key
 * pressed just after a bank or profile switch played the bank you had just
 * left — at the new bank's key position.
 *
 * The rule now has one name. These are the cases that distinguish "worth
 * drawing" from "safe to act on".
 */
// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, it, expect } from "vitest";
import { actionablePadConfigs, NO_CONFIGS } from "@/hooks/usePadConfigurations";
import type { PadConfiguration } from "@/lib/db";

const {
  addProfile,
  upsertPadConfiguration,
  getPadConfigurationsForProfileBank,
} = await import("@/lib/db");

let profileId: number;

beforeEach(async () => {
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });
});

const pad = (padIndex: number): PadConfiguration =>
  ({
    profileId: 1,
    bankId: "0",
    padIndex,
    audioFileIds: [padIndex + 100],
  }) as PadConfiguration;

const bankOne = new Map([
  [0, pad(0)],
  [1, pad(1)],
]);

describe("actionablePadConfigs", () => {
  it("hands back the configs once the read has settled", () => {
    expect(actionablePadConfigs(bankOne, false)).toBe(bankOne);
  });

  it("hands back nothing while a newer read is in flight", () => {
    // The whole finding: these are the previous bank's pads, and the keys
    // being pressed now belong to the new one.
    expect(actionablePadConfigs(bankOne, true).size).toBe(0);
  });

  it("returns the shared empty map, not a fresh one, while loading", () => {
    // A consumer holds this in a ref and compares by identity; handing back a
    // new Map each render would look like a change on every render.
    expect(actionablePadConfigs(bankOne, true)).toBe(NO_CONFIGS);
    expect(actionablePadConfigs(bankOne, true)).toBe(
      actionablePadConfigs(new Map(), true),
    );
  });

  it("does not mutate what it is given", () => {
    actionablePadConfigs(bankOne, true);
    expect(bankOne.size).toBe(2);
    expect(NO_CONFIGS.size).toBe(0);
  });

  it("asks for the pads of a bank by its identity", async () => {
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      audioFileIds: [1],
      playbackType: "sequential",
    });

    const pads = await getPadConfigurationsForProfileBank(profileId, "0");

    expect(pads.map((pad) => pad.padIndex)).toContain(0);
  });
});
