import { describe, expect, it, vi } from "vitest";
import { nextBackfillBatch, shouldAnalyse } from "./pipeline";
import { LOUDNESS_ALGO_VERSION } from "./constants";

describe("shouldAnalyse", () => {
  it("analyses a file with no analysis", () => {
    expect(shouldAnalyse(undefined)).toBe(true);
  });

  it("re-analyses a file from an older algorithm version", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION - 1,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(true);
  });

  it("leaves a current analysis alone", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(false);
  });
});

describe("nextBackfillBatch", () => {
  it("takes at most the batch size", () => {
    expect(nextBackfillBatch([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });

  it("takes everything when fewer remain than the batch size", () => {
    expect(nextBackfillBatch([1], 3)).toEqual([1]);
  });

  it("returns empty for an empty queue", () => {
    expect(nextBackfillBatch([], 3)).toEqual([]);
  });
});
