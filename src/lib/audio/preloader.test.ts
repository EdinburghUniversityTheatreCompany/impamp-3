import { beforeEach, describe, expect, it, vi } from "vitest";

// The decoder pulls in the Web Audio API, which Vitest's node environment has
// no business providing — the preloader's job is deciding *what* to load, so
// the loading itself is stubbed.
const pipelinedLoad = vi.fn();
vi.mock("./decoder", () => ({
  loadAndDecodeAudioPipelined: (...args: unknown[]) => pipelinedLoad(...args),
}));

const { audioPreloader } = await import("./preloader");
const { clearAudioCache, getCachedAudioBuffer, isAudioBufferCached } =
  await import("./cache");

function fakeBuffer(): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: 48000,
    duration: 1,
    length: 48000,
  } as unknown as AudioBuffer;
}

describe("preloading an armed track", () => {
  beforeEach(() => {
    clearAudioCache();
    audioPreloader.clearQueue();
    pipelinedLoad.mockReset();
    pipelinedLoad.mockImplementation(async (audioFileIds: number[]) => {
      return new Map(audioFileIds.map((id) => [id, fakeBuffer()]));
    });
  });

  it("decodes every sound of the armed pad into the cache", async () => {
    audioPreloader.preloadArmedTrack([11, 12], {
      profileId: 1,
      pageIndex: 2,
      padIndex: 3,
    });

    await vi.waitFor(() => {
      expect(isAudioBufferCached(11)).toBe(true);
      expect(isAudioBufferCached(12)).toBe(true);
    });
    expect(getCachedAudioBuffer(11)).not.toBeNull();
  });

  it("loads armed sounds at the highest priority", async () => {
    audioPreloader.preloadArmedTrack([21], {
      profileId: 1,
      pageIndex: 2,
      padIndex: 3,
    });

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());

    // The load concurrency the preloader picks is how IMMEDIATE priority shows
    // up at this boundary: 8 parallel loads, versus 6 for background work.
    const [ids, loadConcurrency] = pipelinedLoad.mock.calls[0];
    expect(ids).toEqual([21]);
    expect(loadConcurrency).toBe(8);
  });

  it("skips sounds that are already decoded", async () => {
    audioPreloader.preloadArmedTrack([31], {
      profileId: 1,
      pageIndex: 2,
      padIndex: 3,
    });
    await vi.waitFor(() => expect(isAudioBufferCached(31)).toBe(true));
    pipelinedLoad.mockClear();

    // Re-arming the same pad must not re-decode what is already in memory
    audioPreloader.preloadArmedTrack([31], {
      profileId: 1,
      pageIndex: 2,
      padIndex: 3,
    });

    expect(pipelinedLoad).not.toHaveBeenCalled();
  });
});
