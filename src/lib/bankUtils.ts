/**
 * Converts a UI bank number (1-9, 0 for 10, 11-20) to an internal zero-based index (0-19).
 * @param bankNumber The bank number as displayed/entered in the UI.
 * @returns The internal zero-based index, or -1 if the bank number is invalid.
 */
export const convertBankNumberToIndex = (bankNumber: number): number => {
  // Map bank 10 (represented by key 0) to internal index 9
  if (bankNumber === 0) return 9;
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
