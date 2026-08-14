/**
 * Audio Module - K-weighting (ITU-R BS.1770-4)
 *
 * Two cascaded biquads: a high shelf and a high-pass ("RLB"). The standard
 * publishes coefficients only at 48 kHz, so they are derived here from the
 * filter parameters via the bilinear transform at whatever rate the file
 * actually is. Hardcoding the 48 kHz values measurably skews 44.1 kHz
 * material, which is a large share of real content.
 *
 * @module lib/audio/loudness/kWeighting
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// High-shelf stage parameters from BS.1770-4.
const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
// The shelf's mid-band gain exponent, such that Vb = Vh ** this.
const SHELF_VB_EXPONENT = 0.4996667741545416;

// High-pass (RLB) stage parameters from BS.1770-4.
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

/**
 * Derives both K-weighting stages for a given sample rate.
 *
 * Verified: at 48000 this reproduces the coefficients published in
 * BS.1770-4 Tables 1 and 2 to five decimal places.
 */
export function kWeightingCoefficients(sampleRate: number): {
  stage1: Biquad;
  stage2: Biquad;
} {
  // Stage 1 - high shelf
  const k1 = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** SHELF_VB_EXPONENT;
  const k1sq = k1 * k1;
  const denom1 = 1 + k1 / SHELF_Q + k1sq;

  const stage1: Biquad = {
    b0: (vh + (vb * k1) / SHELF_Q + k1sq) / denom1,
    b1: (2 * (k1sq - vh)) / denom1,
    b2: (vh - (vb * k1) / SHELF_Q + k1sq) / denom1,
    a1: (2 * (k1sq - 1)) / denom1,
    a2: (1 - k1 / SHELF_Q + k1sq) / denom1,
  };

  // Stage 2 - high pass. Numerator is fixed at (1, -2, 1).
  const k2 = Math.tan((Math.PI * HP_F0) / sampleRate);
  const k2sq = k2 * k2;
  const denom2 = 1 + k2 / HP_Q + k2sq;

  const stage2: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2sq - 1)) / denom2,
    a2: (1 - k2 / HP_Q + k2sq) / denom2,
  };

  return { stage1, stage2 };
}

/**
 * Direct Form I biquad. Returns a new array; the input is never mutated.
 */
export function applyBiquad(input: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return out;
}

/**
 * Applies the full K-weighting cascade to one channel.
 */
export function kWeight(
  channel: Float32Array,
  sampleRate: number,
): Float32Array {
  const { stage1, stage2 } = kWeightingCoefficients(sampleRate);
  return applyBiquad(applyBiquad(channel, stage1), stage2);
}
