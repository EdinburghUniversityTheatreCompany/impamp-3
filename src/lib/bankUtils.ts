import { MAX_BANKS } from "./constants";

/**
 * The position of bank 10, which is the one bank with two spellings.
 *
 * A property of the digit row rather than of the cap: there are ten number
 * keys, and the tenth is labelled "0". Deliberately not derived from
 * `MAX_BANKS` — raising the cap to 30 would not move it, and tying the two
 * together is how a keyboard quirk gets mistaken for a capacity rule.
 */
const BANK_TEN_INDEX = 9;

/**
 * Converts a UI bank number to an internal zero-based index.
 *
 * Bank 10 has two accepted spellings: `0`, because the "0" digit key is what
 * a person presses for it, and literal `10`, because that is what
 * `convertIndexToBankNumber` returns for position 9 — a caller round-tripping
 * a position through both functions (as every bank-selection handler does)
 * must not need to know about the keyboard's 0-for-10 quirk to get back the
 * position it started with. Accepting both here, once, is what keeps that
 * translation from being re-implemented (and re-forgotten) at each call site.
 *
 * The upper bound is `MAX_BANKS` and is read, not written out. Both bounds
 * used to be literals (`bankNumber <= 20`, `index <= 19`) beside a constant
 * that already said 20, so raising the cap meant editing `db.ts` and then
 * remembering these; `bankUtils.test.ts` narrows the constant and re-imports
 * to prove they follow it.
 *
 * @param bankNumber The bank number as displayed/entered in the UI (1-9, 0 or 10 for bank 10, 11-MAX_BANKS).
 * @returns The internal zero-based index, or -1 if the bank number is invalid.
 */
export const convertBankNumberToIndex = (bankNumber: number): number => {
  // The keyboard's 0-for-10, and the only place the two spellings meet.
  if (bankNumber === 0) return BANK_TEN_INDEX;
  // Every other bank number is its position plus one, bank 10 included.
  if (bankNumber >= 1 && bankNumber <= MAX_BANKS) return bankNumber - 1;
  // Return -1 for any other invalid input
  return -1;
};

/**
 * Converts an internal zero-based index to a UI bank number (1-MAX_BANKS).
 *
 * This direction has no quirk: bank 10 is spelled 10 here, because only a
 * keypress spells it 0 and nothing hands a keypress back to the user.
 *
 * @param index The internal zero-based index.
 * @returns The bank number for display in the UI, or -1 if the index is invalid.
 */
export const convertIndexToBankNumber = (index: number): number => {
  if (index >= 0 && index < MAX_BANKS) return index + 1;
  // Return -1 for any other invalid input
  return -1;
};
