/**
 * `stopAudio` / `fadeOutAudio` dispatch by the shape of the key they are given.
 *
 * The Active Tracks panel's collapsed group row (`PadTrackGroup.tsx`) hands its
 * stop and fade controls the pad's bare base key, while an expanded layer row
 * hands its own controls that layer's instance key. Both go through
 * `useTrackControls.ts` unchanged into `stopAudio`/`fadeOutAudio`, so this is
 * the one place that has to route a base key to the whole-pad function and an
 * instance key to the single-layer function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const playbackMocks = vi.hoisted(() => ({
  stopTrack: vi.fn(),
  stopInstance: vi.fn(),
  fadeOutTrack: vi.fn(),
  fadeOutInstance: vi.fn(),
  stopAllTracks: vi.fn(),
  fadeOutAllTracks: vi.fn(),
  isTrackPlaying: vi.fn(),
  isTrackFading: vi.fn(),
  getActiveTrack: vi.fn(),
  getStopGeneration: vi.fn(),
  stopRequestedSince: vi.fn(),
  playBuffer: vi.fn(),
  playBlobStreaming: vi.fn(),
  waitForStreamingPlayable: vi.fn(),
  clampTrimRange: vi.fn(),
}));

vi.mock("./playback", () => playbackMocks);

const { stopAudio, fadeOutAudio } = await import("./controls");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stopAudio", () => {
  it("stops the whole pad when given a bare base key", () => {
    stopAudio("pad-1");

    expect(playbackMocks.stopTrack).toHaveBeenCalledWith("pad-1");
    expect(playbackMocks.stopInstance).not.toHaveBeenCalled();
  });

  it("stops exactly one layer when given an instance key", () => {
    stopAudio("pad-1#2");

    expect(playbackMocks.stopInstance).toHaveBeenCalledWith("pad-1#2");
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
  });
});

describe("fadeOutAudio", () => {
  it("fades the whole pad when given a bare base key", () => {
    fadeOutAudio("pad-1", 4);

    expect(playbackMocks.fadeOutTrack).toHaveBeenCalledWith("pad-1", 4);
    expect(playbackMocks.fadeOutInstance).not.toHaveBeenCalled();
  });

  it("fades exactly one layer when given an instance key", () => {
    fadeOutAudio("pad-1#2", 4);

    expect(playbackMocks.fadeOutInstance).toHaveBeenCalledWith("pad-1#2", 4);
    expect(playbackMocks.fadeOutTrack).not.toHaveBeenCalled();
  });
});
