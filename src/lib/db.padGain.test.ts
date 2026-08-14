import { describe, expect, it } from "vitest";
import type { PadConfiguration } from "./db";
import { extractPadPlaybackSettings } from "./db";

function pad(overrides: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    padIndex: 0,
    pageIndex: 0,
    audioFileIds: [10, 11],
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("extractPadPlaybackSettings", () => {
  it("carries every field playback depends on", () => {
    const result = extractPadPlaybackSettings(
      pad({
        audioTrimSettings: { 10: { trimStart: 1, trimEnd: 2 } },
        audioGainSettings: { 10: 3.5 },
        padGainDb: -2,
        isDisabled: true,
        name: "Horn",
      }),
    );

    expect(result.audioFileIds).toEqual([10, 11]);
    expect(result.audioTrimSettings).toEqual({
      10: { trimStart: 1, trimEnd: 2 },
    });
    expect(result.audioGainSettings).toEqual({ 10: 3.5 });
    expect(result.padGainDb).toBe(-2);
    expect(result.playbackType).toBe("round-robin");
    expect(result.isDisabled).toBe(true);
    expect(result.name).toBe("Horn");
  });

  it("defaults a pad that predates the gain fields", () => {
    const result = extractPadPlaybackSettings(pad());
    expect(result.audioGainSettings).toBeUndefined();
    expect(result.padGainDb).toBeUndefined();
  });

  it("tolerates a partial pad", () => {
    const result = extractPadPlaybackSettings({ audioFileIds: [1] });
    expect(result.audioFileIds).toEqual([1]);
    expect(result.playbackType).toBe("round-robin");
  });
});
