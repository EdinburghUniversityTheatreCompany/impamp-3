/**
 * Defines shared constants used throughout the application.
 */

// Grid dimensions
export const GRID_ROWS = 4;
export const GRID_COLS = 12;

// Total number of pads based on grid dimensions
export const TOTAL_PADS = GRID_ROWS * GRID_COLS;

// Default name for an unconfigured pad
export const DEFAULT_PAD_NAME = "Empty Pad";

/**
 * Milliseconds in a day.
 *
 * Backup reminder periods are stored in milliseconds and shown in days, so
 * this factor appeared as a local `const MS_IN_DAY = 1000 * 60 * 60 * 24` in
 * three files — the profile card that formats one, the edit form that parses
 * one, and the hook that defaults one.
 */
export const MS_IN_DAY = 1000 * 60 * 60 * 24;

/**
 * The two pads that are transport controls rather than sounds.
 *
 * Their positions are derived from the grid, and that derivation was written
 * out four times: in `PadGrid`, in the bulk importer, and twice more inside
 * `keyboardUtils` — once per direction of its key/index mapping, each with its
 * own copy of the "Row 2, last col" arithmetic and its own comment saying the
 * copies must match. Widen the grid and they stay in step only by luck.
 */
export const SPECIAL_PAD_CONFIG = {
  STOP_ALL: {
    index: 1 * GRID_COLS + (GRID_COLS - 1), // Row 2, last col
    label: "Stop All",
    keyBinding: "Escape", // As `KeyboardEvent.key` reports it
  },
  FADE_OUT_ALL: {
    index: 2 * GRID_COLS + (GRID_COLS - 1), // Row 3, last col
    label: "Fade Out All",
    keyBinding: " ", // Space, again as `KeyboardEvent.key` reports it
  },
} as const;

/** Both special pad positions, for the "is this one of them" checks. */
export const SPECIAL_PAD_INDICES: number[] = [
  SPECIAL_PAD_CONFIG.STOP_ALL.index,
  SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index,
];

/**
 * The first pad with no default key. Rows from here on are reachable from the
 * keyboard only through a binding the user sets.
 */
export const MANUAL_ROW_START_INDEX = 3 * GRID_COLS;
