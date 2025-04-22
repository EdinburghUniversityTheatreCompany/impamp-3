import { GRID_COLS } from "./constants";

/**
 * Gets the default keyboard key associated with a pad index based on a standard layout
 * and specific application overrides (e.g., for Stop All, Fade Out All).
 *
 * @param padIndex The index of the pad (0-based).
 * @returns The corresponding key string (e.g., 'q', 'Escape', ' ') or undefined if no default mapping exists.
 */
export const getDefaultKeyForPadIndex = (padIndex: number): string | undefined => {
  // Define special indices based on the grid layout
  // These might need adjustment if the grid layout changes significantly
  const STOP_ALL_INDEX = 1 * GRID_COLS + (GRID_COLS - 1); // Assumes Stop All is in Row 2, last col
  const FADE_OUT_ALL_INDEX = 2 * GRID_COLS + (GRID_COLS - 1); // Assumes Fade Out is in Row 3, last col
  const MANUAL_ROW_START_INDEX = 3 * GRID_COLS; // Assumes manual row starts at Row 4

  // Check for special pads first
  if (padIndex === STOP_ALL_INDEX) {
    return 'Escape'; // Use 'Escape' to match KeyboardEvent.key
  }
  if (padIndex === FADE_OUT_ALL_INDEX) {
    return ' '; // Use ' ' (space) to match KeyboardEvent.key
  }
  // Check if pad is in the manual row (or beyond)
  if (padIndex >= MANUAL_ROW_START_INDEX) {
    return undefined; // No default keys for manual rows
  }

  // Define keyboard rows for the first 3 rows (indices 0 up to MANUAL_ROW_START_INDEX)
  // Adjust the keys based on the desired default layout for the grid size
  // This example assumes a layout similar to the original Pad.tsx
  const keyboardRows = [
    // Row 1 (Indices 0 to cols-1)
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']'], // Example for 12 cols
    // Row 2 (Indices cols to 2*cols-1) - Excluding STOP_ALL_INDEX
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"], // Example for 12 cols (Stop All is handled above)
    // Row 3 (Indices 2*cols to 3*cols-1) - Excluding FADE_OUT_ALL_INDEX
    ['\\', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'], // Example for 12 cols (Fade Out is handled above)
  ];

  // Calculate row and column for the pad index relative to the grid
  const row = Math.floor(padIndex / GRID_COLS);
  const col = padIndex % GRID_COLS;

  // Check if we have a key defined for this position within the mapped rows
  if (row < keyboardRows.length && col < keyboardRows[row].length) {
    const key = keyboardRows[row][col];
    // Ensure we don't accidentally return a key for the special indices if the logic above failed
    // (This check is redundant if the special index handling above is correct, but safe)
    if (key !== undefined && padIndex !== STOP_ALL_INDEX && padIndex !== FADE_OUT_ALL_INDEX) {
        return key;
    }
  }

  // Default case: No key binding for this position
  return undefined;
};
