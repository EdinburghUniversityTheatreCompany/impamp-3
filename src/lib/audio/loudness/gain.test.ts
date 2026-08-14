import { describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "@/lib/db";
import {
  LOUDNESS_ALGO_VERSION,
  LOUDNESS_OFFSET_DB,
  MAX_GAIN,
  MAX_NORM_BOOST_DB,
  MAX_TOTAL_GAIN_DB,
} from "./constants";
import { resolveGain } from "./gain";
import { DEFAULT_NORMALISATION } from "./types";

/**
 * Builds an analysis that measures exactly `lufs` with exactly `peakDb`,
 * by inverting the block-loudness formula. Ten identical blocks means both
 * gates pass everything, so the gated result equals the block value.
 */
function fakeAnalysis(lufs: number, peakDb: number): LoudnessAnalysis {
  const w = 10 ** ((lufs - LOUDNESS_OFFSET_DB) / 10);
  const blocks = new Float32Array(10).fill(w);
  const peaks = new Float32Array(20).fill(10 ** (peakDb / 20));
  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate: 48000,
    duration: 2,
    blockMeanSquare: blocks,
    hopTruePeak: peaks,
  };
}

const base = {
  trimStart: 0,
  trimEnd: undefined,
  soundGainDb: 0,
  padGainDb: 0,
  normalisation: DEFAULT_NORMALISATION,
};

describe("resolveGain", () => {
  it("boosts a quiet file to the target", () => {
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-27, -12) });
    expect(r.normDb).toBeCloseTo(11, 1);
    expect(r.finalLufs).toBeCloseTo(-16, 1);
    expect(r.peakLimited).toBe(false);
    expect(r.willClip).toBe(false);
  });

  it("attenuates a loud file to the target", () => {
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-9, -1) });
    expect(r.normDb).toBeCloseTo(-7, 1);
    expect(r.finalLufs).toBeCloseTo(-16, 1);
  });

  it("clamps boost at the peak ceiling and flags it", () => {
    // -30 LUFS wants +14 dB, but a -0.1 dBTP peak leaves only -0.9 dB.
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-30, -0.1) });
    expect(r.normDb).toBeCloseTo(-0.9, 1);
    expect(r.peakLimited).toBe(true);
    expect(r.finalLufs).toBeCloseTo(-30.9, 1);
  });

  it("caps automatic boost at MAX_NORM_BOOST_DB", () => {
    // -60 LUFS with a very low peak would otherwise ask for +44 dB.
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-60, -55) });
    expect(r.normDb).toBe(MAX_NORM_BOOST_DB);
    expect(r.boostCapped).toBe(true);
  });

  it("adds both manual gains on top of normalisation", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      soundGainDb: 3,
      padGainDb: -1,
    });
    expect(r.totalDb).toBeCloseTo(13, 1);
    expect(r.finalLufs).toBeCloseTo(-14, 1);
  });

  it("warns when manual gain pushes an otherwise-safe sound into clipping", () => {
    const safe = resolveGain({ ...base, analysis: fakeAnalysis(-27, -12) });
    expect(safe.willClip).toBe(false);

    const clipping = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      soundGainDb: 6,
    });
    expect(clipping.predictedPeakDb).toBeGreaterThan(0);
    expect(clipping.willClip).toBe(true);
  });

  it("applies no normalisation when disabled", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      normalisation: { enabled: false, targetLufs: -16 },
    });
    expect(r.normDb).toBe(0);
    expect(r.linear).toBe(1);
  });

  it("applies no normalisation when the file is unmeasured", () => {
    const r = resolveGain({ ...base, analysis: undefined });
    expect(r.normDb).toBe(0);
    expect(r.unmeasured).toBe(true);
    expect(r.linear).toBe(1);
    expect(r.measuredLufs).toBeNull();
  });

  it("still applies manual gain to an unmeasured file", () => {
    const r = resolveGain({ ...base, analysis: undefined, soundGainDb: 6 });
    expect(r.totalDb).toBeCloseTo(6, 5);
    expect(r.linear).toBeCloseTo(10 ** (6 / 20), 5);
  });

  it("never exceeds MAX_GAIN and reports the clamp", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-60, -55),
      soundGainDb: 12,
      padGainDb: 12,
    });
    expect(r.totalDb).toBe(MAX_TOTAL_GAIN_DB);
    expect(r.gainClamped).toBe(true);
    expect(r.linear).toBeLessThanOrEqual(MAX_GAIN + 1e-6);
  });

  it("reports figures from the applied gain, not the requested gain", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-60, -55),
      soundGainDb: 12,
      padGainDb: 12,
    });
    // finalLufs must reflect totalDb after clamping, or the table lies.
    expect(r.finalLufs).toBeCloseTo(-60 + MAX_TOTAL_GAIN_DB, 1);
    expect(r.predictedPeakDb).toBeCloseTo(-55 + MAX_TOTAL_GAIN_DB, 1);
  });

  it("measures only the trimmed region", () => {
    const analysis = fakeAnalysis(-27, -12);
    const full = resolveGain({ ...base, analysis });
    const trimmed = resolveGain({
      ...base,
      analysis,
      trimStart: 0.5,
      trimEnd: 1.5,
    });
    // Constant signal, so the values agree — but the trimmed call must have
    // gone through the range path rather than ignoring the trim.
    expect(trimmed.measuredLufs).toBeCloseTo(full.measuredLufs as number, 1);
    expect(trimmed.estimated).toBe(false);
  });
});
