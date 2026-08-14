/**
 * Audio Module - Loudness display formatting
 *
 * Uses a real minus sign (U+2212) rather than a hyphen so columns of numbers
 * align and negative values read clearly at small sizes.
 *
 * @module lib/audio/loudness/format
 */

const MINUS = "−";

/**
 * Formats a gain in dB with an explicit sign. Never returns bare "0".
 *
 * Rounds the magnitude directly with `toFixed` rather than pre-rounding via
 * `Math.round(db * 10) / 10` — that intermediate multiply lands on values
 * like `-32.499999999999996` for an exact input of `-3.25`, which rounds
 * the wrong way and disagrees with `toFixed`'s own rounding.
 */
export function formatGainDb(db: number): string {
  const magnitude = Math.abs(db).toFixed(1);
  if (parseFloat(magnitude) === 0) return "0.0";
  return db > 0 ? `+${magnitude}` : `${MINUS}${magnitude}`;
}

/** Formats a LUFS measurement, or an em dash when there is nothing to show. */
export function formatLufs(lufs: number | null): string {
  if (lufs === null || !Number.isFinite(lufs)) return "—";
  const magnitude = Math.abs(lufs).toFixed(1);
  return lufs < 0 && parseFloat(magnitude) !== 0
    ? `${MINUS}${magnitude}`
    : magnitude;
}

/**
 * Tailwind classes marking a gain as boosted, cut or unity.
 *
 * Decoration only — the signed number is always rendered beside it, so no
 * meaning is lost to a colour-blind reader or a screen reader.
 */
export function gainToneClass(db: number): string {
  if (Math.abs(db) < 0.05) return "text-gray-500 dark:text-gray-400";
  return db > 0
    ? "text-amber-700 dark:text-amber-300"
    : "text-sky-700 dark:text-sky-300";
}
