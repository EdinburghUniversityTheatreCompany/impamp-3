import { GRID_COLS } from "./constants";

// Define keyboard rows for the first 3 rows (indices 0 up to MANUAL_ROW_START_INDEX)
// Adjust the keys based on the desired default layout for the grid size
const KEYBOARD_ROWS = [
  // Row 1 (Indices 0 to cols-1)
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "[", "]"],
  // Row 2 (Indices cols to 2*cols-1) - Excluding STOP_ALL_INDEX
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'"],
  // Row 3 (Indices 2*cols to 3*cols-1) - Excluding FADE_OUT_ALL_INDEX
  ["\\", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/"],
];

/**
 * Gets the default keyboard key associated with a pad index based on a standard layout
 * and specific application overrides (e.g., for Stop All, Fade Out All).
 *
 * @param padIndex The index of the pad (0-based).
 * @returns The corresponding key string (e.g., 'q', 'Escape', ' ') or undefined if no default mapping exists.
 */
export const getDefaultKeyForPadIndex = (
  padIndex: number,
): string | undefined => {
  // Define special indices based on the grid layout
  // These might need adjustment if the grid layout changes significantly
  const STOP_ALL_INDEX = 1 * GRID_COLS + (GRID_COLS - 1); // Assumes Stop All is in Row 2, last col
  const FADE_OUT_ALL_INDEX = 2 * GRID_COLS + (GRID_COLS - 1); // Assumes Fade Out is in Row 3, last col
  const MANUAL_ROW_START_INDEX = 3 * GRID_COLS; // Assumes manual row starts at Row 4

  // Check for special pads first
  if (padIndex === STOP_ALL_INDEX) {
    return "Escape"; // Use 'Escape' to match KeyboardEvent.key
  }
  if (padIndex === FADE_OUT_ALL_INDEX) {
    return " "; // Use ' ' (space) to match KeyboardEvent.key
  }
  // Check if pad is in the manual row (or beyond)
  if (padIndex >= MANUAL_ROW_START_INDEX) {
    return undefined; // No default keys for manual rows
  }

  // Calculate row and column for the pad index relative to the grid
  const row = Math.floor(padIndex / GRID_COLS);
  const col = padIndex % GRID_COLS;

  // Check if we have a key defined for this position within the mapped rows
  if (row < KEYBOARD_ROWS.length && col < KEYBOARD_ROWS[row].length) {
    const key = KEYBOARD_ROWS[row][col];
    // Ensure we don't accidentally return a key for the special indices if the logic above failed
    // (This check is redundant if the special index handling above is correct, but safe)
    if (
      key !== undefined &&
      padIndex !== STOP_ALL_INDEX &&
      padIndex !== FADE_OUT_ALL_INDEX
    ) {
      return key;
    }
  }

  // Default case: No key binding for this position
  return undefined;
};

/**
 * Gets the pad index (0-based) associated with a specific keyboard key,
 * based on the default layout defined in getDefaultKeyForPadIndex.
 * This is essentially the inverse of getDefaultKeyForPadIndex.
 *
 * @param key The keyboard key string (e.g., 'q', 'Escape', ' ').
 * @returns The corresponding pad index (0-based) or undefined if the key is not mapped.
 */
export const getPadIndexForKey = (key: string): number | undefined => {
  // Define special indices based on the grid layout (must match getDefaultKeyForPadIndex)
  const STOP_ALL_INDEX = 1 * GRID_COLS + (GRID_COLS - 1); // Assumes Stop All is in Row 2, last col
  const FADE_OUT_ALL_INDEX = 2 * GRID_COLS + (GRID_COLS - 1); // Assumes Fade Out is in Row 3, last col
  const MANUAL_ROW_START_INDEX = 3 * GRID_COLS; // Assumes manual row starts at Row 4

  // Check for special keys first
  if (key === "Escape") {
    return STOP_ALL_INDEX;
  }
  if (key === " ") {
    // Check for space key
    return FADE_OUT_ALL_INDEX;
  }

  // Iterate through the defined rows to find the key
  for (let row = 0; row < KEYBOARD_ROWS.length; row++) {
    const col = KEYBOARD_ROWS[row].indexOf(key);
    if (col !== -1) {
      // Key found, calculate the pad index
      const padIndex = row * GRID_COLS + col;

      // Important: Ensure the calculated index doesn't accidentally match a special index
      // that should have been handled above or is outside the mapped range.
      // This check prevents mapping regular keys to special function pads if the layout changes.
      if (
        padIndex < MANUAL_ROW_START_INDEX &&
        padIndex !== STOP_ALL_INDEX &&
        padIndex !== FADE_OUT_ALL_INDEX
      ) {
        return padIndex;
      }
    }
  }

  // Key not found in the mapped rows
  return undefined;
};

/**
 * Elements the browser itself activates with Enter or Space while they hold
 * focus. `role` counts as well as the tag, because the chrome contains
 * `role="tab"` buttons and dnd-driven handles.
 */
const ACTIVATION_TAGS = new Set(["BUTTON", "A", "SELECT", "SUMMARY"]);
const ACTIVATION_ROLES = new Set([
  "button",
  "tab",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "switch",
  "checkbox",
  "radio",
  "option",
]);

/** The slice of an element this needs — so it is testable without a DOM. */
export interface ActivationTarget {
  tagName: string;
  getAttribute(name: string): string | null;
}

/**
 * Whether a keydown is one the control holding focus would activate on.
 *
 * Enter is the emergency bank and Space is Fade Out All, globally, and they
 * have to keep meaning that at every moment of a show. But the header, the
 * bank tabs and the profile selector are ordinary controls a keyboard user
 * must be able to operate, and those two keys are how a button is pressed —
 * so the hook hands them over, but only for focus the operator moved there
 * with Tab (see `useKeyboardListener`).
 *
 * Only Enter and Space are ever claimed. A letter still fires its pad and a
 * digit still switches bank while focus sits in the chrome, because no
 * control activates on those.
 *
 * `:focus-visible` looks like the natural test for "reached by keyboard" and
 * is the wrong one here: Chromium flips an already-focused element to
 * focus-visible on the very keydown being judged, so a button focused by a
 * click reports true the moment Space is pressed — which is precisely the
 * case that has to keep Fade Out All.
 */
export function isControlActivationKey(key: string, target: unknown): boolean {
  if (key !== "Enter" && key !== " ") return false;

  const el = target as Partial<ActivationTarget> | null;
  if (
    !el ||
    typeof el.tagName !== "string" ||
    typeof el.getAttribute !== "function"
  ) {
    return false;
  }

  const role = el.getAttribute("role");
  return (
    ACTIVATION_TAGS.has(el.tagName) ||
    (role !== null && ACTIVATION_ROLES.has(role))
  );
}
