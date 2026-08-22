/**
 * The bank number the UI shows, the index the app stores, and the one place
 * the range they span is written down.
 *
 * These two functions had the cap spelled out as literals — `bankNumber <= 20`
 * on one side, `index <= 19` on the other — while `MAX_BANKS` lived in `db.ts`
 * and governed everything else about capacity. Correct, and correct only by
 * coincidence: raising the cap means editing the constant and then finding
 * these, and "the same rule written twice" is this repo's characteristic
 * regression.
 *
 * So the last test here is the point of the file. The others pin the mapping
 * itself, which must not move: the keyboard's "0 means bank 10" is a real
 * quirk of the digit row and stays exactly where it is.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_BANKS } from "./constants";
import {
  convertBankNumberToIndex,
  convertIndexToBankNumber,
} from "./bankUtils";

describe("bank number and index", () => {
  it("round-trips every position a profile can hold", () => {
    for (let index = 0; index < MAX_BANKS; index++) {
      const bankNumber = convertIndexToBankNumber(index);
      expect(bankNumber).toBe(index + 1);
      expect(convertBankNumberToIndex(bankNumber)).toBe(index);
    }
  });

  it("accepts both spellings of bank 10", () => {
    // The "0" digit key is what a person presses for the tenth bank, so `0`
    // arrives here from the keyboard; `10` arrives from every caller that got
    // its number out of `convertIndexToBankNumber`. Both mean position 9.
    expect(convertBankNumberToIndex(0)).toBe(9);
    expect(convertBankNumberToIndex(10)).toBe(9);
    // Only the inbound direction has the quirk. Position 9 is spelled 10.
    expect(convertIndexToBankNumber(9)).toBe(10);
  });

  it("rejects anything outside the range", () => {
    expect(convertBankNumberToIndex(-1)).toBe(-1);
    expect(convertBankNumberToIndex(MAX_BANKS + 1)).toBe(-1);
    expect(convertIndexToBankNumber(-1)).toBe(-1);
    expect(convertIndexToBankNumber(MAX_BANKS)).toBe(-1);
  });

  it("takes its bounds from MAX_BANKS, not from a literal", async () => {
    // Narrow the cap and re-import: a mapping that reads the constant follows
    // it, and one carrying `<= 20` in its own source does not. This is the
    // only way to tell those two apart while the constant is 20, which is why
    // the three tests above cannot do it.
    vi.resetModules();
    vi.doMock("./constants", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./constants")>()),
      MAX_BANKS: 12,
    }));
    try {
      const narrowed = await import("./bankUtils");
      expect(narrowed.convertBankNumberToIndex(12)).toBe(11);
      expect(narrowed.convertBankNumberToIndex(13)).toBe(-1);
      expect(narrowed.convertIndexToBankNumber(11)).toBe(12);
      expect(narrowed.convertIndexToBankNumber(12)).toBe(-1);
      // The keyboard quirk is not a function of the cap and must survive it.
      expect(narrowed.convertBankNumberToIndex(0)).toBe(9);
    } finally {
      vi.doUnmock("./constants");
      vi.resetModules();
    }
  });
});
