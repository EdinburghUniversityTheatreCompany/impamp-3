/**
 * Audio Module - Loudness constants
 *
 * Every numeric constant for BS.1770-4 analysis and gain resolution.
 * No logic lives here so the values can be imported by tests without
 * pulling in the analysis engine.
 *
 * @module lib/audio/loudness/constants
 */

/** Gating block length in seconds (BS.1770-4). */
export const BLOCK_SECONDS = 0.4;
/** Gating hop length in seconds — 75% overlap. */
export const HOP_SECONDS = 0.1;
/** Loudness offset from BS.1770-4, compensating the K-filter gain at the 997 Hz calibration tone. */
export const LOUDNESS_OFFSET_DB = -0.691;
/** Absolute gate threshold, LUFS. */
export const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate, LU below the absolute-gated mean. */
export const RELATIVE_GATE_LU = -10;

/** True-peak ceiling that normalisation gain must respect, dBTP. */
export const PEAK_CEILING_DBTP = -1;
/**
 * Cap on automatic boost, dB. A very quietly recorded file that is not quite
 * silent enough to trip the absolute gate could otherwise ask for +39 dB.
 */
export const MAX_NORM_BOOST_DB = 24;
/** Manual gain range offered per knob in the UI, dB. */
export const MANUAL_GAIN_RANGE_DB = { min: -24, max: 12 } as const;
/**
 * Safety rail on the summed gain, dB. Reachable only by stacking a large
 * automatic boost with both manual knobs; when it bites, `gainClamped` is set
 * so the UI reports the level that will actually play.
 */
export const MAX_TOTAL_GAIN_DB = 36;
/** Linear form of MAX_TOTAL_GAIN_DB. Replaces the old playback clamp of 1. */
export const MAX_GAIN = 10 ** (MAX_TOTAL_GAIN_DB / 20);

/** Bump to force re-analysis of every stored file. */
export const LOUDNESS_ALGO_VERSION = 1;

/** Oversampling factor for true-peak detection. */
export const TRUE_PEAK_OVERSAMPLE = 4;
/** Taps per polyphase branch of the true-peak interpolator. */
export const TRUE_PEAK_TAPS_PER_PHASE = 12;
