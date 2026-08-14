import { describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "./db";
import { deserialiseLoudness, serialiseLoudness } from "./importExport";
import { LOUDNESS_ALGO_VERSION } from "./audio/loudness/constants";

function analysis(): LoudnessAnalysis {
  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate: 48000,
    duration: 1.5,
    blockMeanSquare: Float32Array.from([0.001, 0.002, 0.003]),
    hopTruePeak: Float32Array.from([0.5, 0.6]),
  };
}

describe("loudness serialisation", () => {
  it("round-trips an analysis", () => {
    const restored = deserialiseLoudness(serialiseLoudness(analysis()));
    expect(restored).not.toBeNull();
    expect(restored?.sampleRate).toBe(48000);
    expect(restored?.duration).toBeCloseTo(1.5, 5);
    expect(Array.from(restored?.blockMeanSquare ?? [])).toEqual([
      expect.closeTo(0.001, 6),
      expect.closeTo(0.002, 6),
      expect.closeTo(0.003, 6),
    ]);
    expect(restored?.hopTruePeak.length).toBe(2);
  });

  // A stale measurement would produce confidently wrong levels, which is
  // worse than no measurement at all.
  it("drops an analysis from a different algorithm version", () => {
    const serialised = serialiseLoudness({
      ...analysis(),
      algoVersion: LOUDNESS_ALGO_VERSION + 1,
    });
    expect(deserialiseLoudness(serialised)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(deserialiseLoudness(undefined)).toBeNull();
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(
      deserialiseLoudness({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: "not base64!!!",
        hopTruePeak: "also not",
      }),
    ).toBeNull();
  });
});
