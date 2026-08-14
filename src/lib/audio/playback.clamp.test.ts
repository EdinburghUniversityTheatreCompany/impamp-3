import { describe, expect, it } from "vitest";
import { MAX_GAIN } from "./loudness/constants";
import { clampPlaybackGain } from "./playback";

describe("clampPlaybackGain", () => {
  it("allows boost above unity so quiet files can reach target", () => {
    // The old clamp of 1 made normalisation unable to raise anything.
    expect(clampPlaybackGain(4)).toBe(4);
  });

  it("clamps at MAX_GAIN", () => {
    expect(clampPlaybackGain(MAX_GAIN * 10)).toBe(MAX_GAIN);
  });

  it("floors at zero", () => {
    expect(clampPlaybackGain(-3)).toBe(0);
  });

  it("passes unity through", () => {
    expect(clampPlaybackGain(1)).toBe(1);
  });

  it("treats a non-finite value as unity rather than silencing the pad", () => {
    expect(clampPlaybackGain(Number.NaN)).toBe(1);
  });
});
