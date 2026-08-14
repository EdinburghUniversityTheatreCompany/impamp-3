import { describe, expect, it } from "vitest";
import { applyBiquad, kWeight, kWeightingCoefficients } from "./kWeighting";

describe("kWeightingCoefficients", () => {
  // BS.1770-4 publishes coefficients only at 48 kHz. If our bilinear
  // derivation is right, it must reproduce them exactly at that rate.
  it("reproduces the published 48 kHz coefficients", () => {
    const { stage1, stage2 } = kWeightingCoefficients(48000);

    expect(stage1.b0).toBeCloseTo(1.53512485958697, 5);
    expect(stage1.b1).toBeCloseTo(-2.69169618940638, 5);
    expect(stage1.b2).toBeCloseTo(1.19839281085285, 5);
    expect(stage1.a1).toBeCloseTo(-1.69065929318241, 5);
    expect(stage1.a2).toBeCloseTo(0.73248077421585, 5);

    expect(stage2.b0).toBeCloseTo(1.0, 10);
    expect(stage2.b1).toBeCloseTo(-2.0, 10);
    expect(stage2.b2).toBeCloseTo(1.0, 10);
    expect(stage2.a1).toBeCloseTo(-1.99004745483398, 5);
    expect(stage2.a2).toBeCloseTo(0.99007225036621, 5);
  });

  it("produces different coefficients at 44.1 kHz", () => {
    const at48 = kWeightingCoefficients(48000);
    const at441 = kWeightingCoefficients(44100);
    // If these matched, the implementation hardcoded 48 kHz values and every
    // 44.1 kHz measurement would be wrong.
    expect(at441.stage1.b0).not.toBeCloseTo(at48.stage1.b0, 4);
  });
});

describe("applyBiquad", () => {
  it("passes a signal through a unity filter unchanged", () => {
    const input = Float32Array.from([1, -0.5, 0.25, 0]);
    const out = applyBiquad(input, { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
    expect(Array.from(out)).toEqual([1, -0.5, 0.25, 0]);
  });

  it("does not mutate its input", () => {
    const input = Float32Array.from([1, 1, 1, 1]);
    applyBiquad(input, { b0: 0.5, b1: 0, b2: 0, a1: 0, a2: 0 });
    expect(Array.from(input)).toEqual([1, 1, 1, 1]);
  });
});

describe("kWeight", () => {
  // The -0.691 offset in BS.1770 exists precisely to cancel the K-filter's
  // gain at its calibration tone, so that gain must be +0.691 dB. This pins
  // the whole filter cascade with a single number.
  //
  // BS.1770's calibration tone is 997 Hz, not exactly 1 kHz — 997 is prime,
  // which avoids the tone landing on a rational fraction of the sample rate.
  // At exactly 1000 Hz the true gain of this same filter is ~0.698 dB
  // (verified analytically via the z-transform and by simulating the
  // published 48 kHz coefficients directly), so 1000 Hz would not pin the
  // filter to +0.691 dB regardless of implementation.
  it("has a gain of +0.691 dB at 997 Hz (BS.1770's calibration tone)", () => {
    const sampleRate = 48000;
    const seconds = 2;
    const n = sampleRate * seconds;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin((2 * Math.PI * 997 * i) / sampleRate);
    }

    const out = kWeight(input, sampleRate);

    // Measure RMS over the second half only, so filter start-up transients
    // have decayed and do not bias the result.
    const from = Math.floor(n / 2);
    let inSum = 0;
    let outSum = 0;
    for (let i = from; i < n; i++) {
      inSum += input[i] * input[i];
      outSum += out[i] * out[i];
    }
    const gainDb = 10 * Math.log10(outSum / inSum);
    expect(gainDb).toBeCloseTo(0.691, 2);
  });
});
