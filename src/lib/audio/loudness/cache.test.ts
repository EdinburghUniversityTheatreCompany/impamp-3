import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoudnessAnalysis } from "@/lib/db";
import {
  clearLoudnessCache,
  getCachedLoudness,
  getLoudnessCacheSize,
  setCachedLoudness,
  subscribeToLoudnessCache,
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

  describe("subscribeToLoudnessCache", () => {
    it("fires when setCachedLoudness writes an entry", () => {
      const listener = vi.fn();
      subscribeToLoudnessCache(listener);
      setCachedLoudness(1, analysis());
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fires when warmLoudnessCache replaces the cache", () => {
      const listener = vi.fn();
      subscribeToLoudnessCache(listener);
      warmLoudnessCache([[1, analysis()]]);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fires when clearLoudnessCache empties the cache", () => {
      setCachedLoudness(1, analysis());
      const listener = vi.fn();
      subscribeToLoudnessCache(listener);
      clearLoudnessCache();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does not fire after unsubscribing", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToLoudnessCache(listener);
      unsubscribe();
      setCachedLoudness(1, analysis());
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
