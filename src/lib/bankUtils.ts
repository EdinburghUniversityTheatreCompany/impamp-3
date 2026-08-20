/**
 * Converts a UI bank number to an internal zero-based index (0-19).
 *
 * Bank 10 has two accepted spellings: `0`, because the "0" digit key is what
 * a person presses for it, and literal `10`, because that is what
 * `convertIndexToBankNumber` returns for position 9 — a caller round-tripping
 * a position through both functions (as every bank-selection handler does)
 * must not need to know about the keyboard's 0-for-10 quirk to get back the
 * position it started with. Accepting both here, once, is what keeps that
 * translation from being re-implemented (and re-forgotten) at each call site.
 *
 * @param bankNumber The bank number as displayed/entered in the UI (1-9, 0 or 10 for bank 10, 11-20).
 * @returns The internal zero-based index, or -1 if the bank number is invalid.
 */
export const convertBankNumberToIndex = (bankNumber: number): number => {
  // Map bank 10 — spelled as the "0" key or as the literal 10 — to internal index 9
  if (bankNumber === 0 || bankNumber === 10) return 9;
  // Map banks 1-9 to indices 0-8
  if (bankNumber >= 1 && bankNumber <= 9) return bankNumber - 1;
  // Map banks 11-20 to indices 10-19
  if (bankNumber >= 11 && bankNumber <= 20) return bankNumber - 1;
  // Return -1 for any other invalid input
  return -1;
};

/**
 * Converts an internal zero-based index (0-19) to a UI bank number (1-20).
 * Note: Bank 10 is represented as 10 in the UI.
 * @param index The internal zero-based index.
 * @returns The bank number for display in the UI, or -1 if the index is invalid.
 */
export const convertIndexToBankNumber = (index: number): number => {
  // Map indices 0-8 to banks 1-9
  if (index >= 0 && index <= 8) return index + 1;
  // Map index 9 to bank 10
  if (index === 9) return 10;
  // Map indices 10-19 to banks 11-20
  if (index >= 10 && index <= 19) return index + 1;
  // Return -1 for any other invalid input
  return -1;
};
