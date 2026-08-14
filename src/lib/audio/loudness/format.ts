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
 *
 * A non-finite input (NaN, ±Infinity) renders as `"0.0"` rather than
 * propagating — without this guard `Math.abs(NaN).toFixed(1)` is the
 * string `"NaN"`, which slips past the `=== 0` unity check and the
 * `> 0` sign check to print `"−NaN"`: a value that looks like a
 * plausible small negative gain instead of an obvious error. `"0.0"` is
 * chosen to agree with `clampPlaybackGain` (`src/lib/audio/playback.ts`),
 * which maps a non-finite requested gain to unity (linear `1`, i.e. 0 dB)
 * before it ever reaches a `GainNode` — so this is what the sound will
 * actually play at, not an arbitrary fallback.
 */
export function formatGainDb(db: number): string {
  if (!Number.isFinite(db)) return "0.0";
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
 *
 * A non-finite input is treated as unity (the gray class), matching
 * `formatGainDb`'s `"0.0"` for the same input — the number and the colour
 * must never disagree. Without this, `NaN`/`Infinity` fail both
 * `Math.abs(db) < 0.05` and `db > 0` (every comparison against `NaN` is
 * `false`) and fall through to the cut/blue branch, showing a
 * negative-looking colour beside a value that is not actually negative.
 */
export function gainToneClass(db: number): string {
  if (!Number.isFinite(db) || Math.abs(db) < 0.05)
    return "text-gray-500 dark:text-gray-400";
  return db > 0
    ? "text-amber-700 dark:text-amber-300"
    : "text-sky-700 dark:text-sky-300";
}
