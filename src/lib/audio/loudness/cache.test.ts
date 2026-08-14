import { beforeEach, describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "@/lib/db";
import {
  clearLoudnessCache,
  getCachedLoudness,
  getLoudnessCacheSize,
  setCachedLoudness,
  warmLoudnessCache,
} from "./cache";

function analysis(duration = 1): LoudnessAnalysis {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration,
    blockMeanSquare: new Float32Array(7),
    hopTruePeak: new Float32Array(10),
  };
}

describe("loudness cache", () => {
  beforeEach(() => clearLoudnessCache());

  it("stores and retrieves by audio file id", () => {
    setCachedLoudness(42, analysis(2));
    expect(getCachedLoudness(42)?.duration).toBe(2);
  });

  it("returns undefined for an unknown id", () => {
    expect(getCachedLoudness(999)).toBeUndefined();
  });

  it("replaces the whole cache when warmed", () => {
    setCachedLoudness(1, analysis());
    warmLoudnessCache([
      [2, analysis()],
      [3, analysis()],
    ]);
    expect(getCachedLoudness(1)).toBeUndefined();
    expect(getCachedLoudness(2)).toBeDefined();
    expect(getLoudnessCacheSize()).toBe(2);
  });

  it("clears", () => {
    setCachedLoudness(1, analysis());
    clearLoudnessCache();
    expect(getLoudnessCacheSize()).toBe(0);
  });
});
