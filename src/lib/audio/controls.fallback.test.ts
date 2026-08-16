/**
 * When a pad's chosen sound will not load, the fallback plays a different one
 * — and everything about *how* it plays must follow the substitution.
 *
 * The play parameters were computed once, for the file the strategy chose, and
 * then applied to whatever the fallback managed to load. So a substituted
 * sound played at the failed sound's normalisation gain, inside the failed
 * sound's trim window, and reported the failed sound's id to the playback
 * store — which is what the Active Tracks panel and the E2E gain hook read.
 *
 * A quiet sound substituted for a loud one therefore came out at the loud
 * one's correction, which on a live board is the difference between a cue and
 * a shock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const decoderMocks = vi.hoisted(() => ({
  loadAndDecodeAudioInstant: vi.fn(),
  loadAndDecodeAudioEnhanced: vi.fn(),
  loadAndDecodeAudioPipelined: vi.fn(),
}));

const playbackMocks = vi.hoisted(() => ({
  playBuffer: vi.fn(),
  playBlobStreaming: vi.fn(),
  waitForStreamingPlayable: vi.fn(),
  stopTrack: vi.fn(),
  fadeOutTrack: vi.fn(),
  stopAllTracks: vi.fn(),
  fadeOutAllTracks: vi.fn(),
  isTrackPlaying: vi.fn(() => false),
  isTrackFading: vi.fn(() => false),
  getActiveTrack: vi.fn(() => null),
  getStopGeneration: vi.fn(() => ({ global: 0, key: 0 })),
  stopRequestedSince: vi.fn(() => false),
  clampTrimRange: vi.fn((s: number, e: number) => ({
    trimStart: s,
    trimEnd: e,
  })),
}));

const loudnessMocks = vi.hoisted(() => ({
  getCachedLoudness: vi.fn(),
}));

vi.mock("./decoder", () => decoderMocks);
vi.mock("./playback", () => playbackMocks);
vi.mock("./loudness/cache", () => loudnessMocks);
vi.mock("./cache", () => ({
  getCachedAudioBuffer: vi.fn(() => null),
  clearCachedAudioBuffer: vi.fn(),
}));
vi.mock("./context", () => ({
  resumeAudioContext: vi.fn(),
  getAudioContext: vi.fn(() => ({ state: "running", currentTime: 0 })),
}));
vi.mock("../db", () => ({ getAudioFile: vi.fn(async () => null) }));
vi.mock("./preloader", () => ({
  audioPreloader: { trackPlayedFile: vi.fn() },
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({
      getActivePadBehavior: () => "continue",
      getNormalisationSettings: () => ({ enabled: false, targetLufs: -23 }),
    }),
  },
}));

const { triggerAudioForPadInstant } = await import("./controls");

const GOOD = 200;
const BROKEN = 100;
const fakeBuffer = { duration: 3, numberOfChannels: 2 } as AudioBuffer;

beforeEach(() => {
  vi.clearAllMocks();
  playbackMocks.isTrackPlaying.mockReturnValue(false);
  playbackMocks.isTrackFading.mockReturnValue(false);
  playbackMocks.stopRequestedSince.mockReturnValue(false);
  loudnessMocks.getCachedLoudness.mockReturnValue(undefined);

  // The chosen sound fails; the alternative loads.
  decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(null);
  decoderMocks.loadAndDecodeAudioEnhanced.mockImplementation(
    async (id: number) => (id === GOOD ? fakeBuffer : null),
  );
});

// Playback strategies are keyed by playback key and persist for the life of
// the module, so each test gets its own pad rather than inheriting whichever
// sound the previous test's sequential cursor landed on.
let nextPadIndex = 0;

/** Triggers a pad whose first sound is broken and second is fine. */
async function triggerWithFallback() {
  await triggerAudioForPadInstant({
    padIndex: nextPadIndex++,
    audioFileIds: [BROKEN, GOOD],
    playbackType: "sequential",
    activeProfileId: 1,
    currentPageIndex: 0,
    name: "Pad",
    // Deliberately different per sound, so it is obvious which was used.
    audioGainSettings: { [BROKEN]: -12, [GOOD]: 0 },
    audioTrimSettings: {
      [BROKEN]: { trimStart: 5, trimEnd: 6 },
      [GOOD]: { trimStart: 0, trimEnd: 3 },
    },
    padGainDb: 0,
  });
}

describe("falling back to another sound on a pad", () => {
  it("plays it at its own gain, not the failed sound's", async () => {
    await triggerWithFallback();

    expect(playbackMocks.playBuffer).toHaveBeenCalledTimes(1);
    const params = playbackMocks.playBuffer.mock.calls[0][2];

    // -12 dB is roughly 0.25 linear; the substitute asks for 0 dB.
    expect(params.volume).toBeCloseTo(1, 5);
  });

  it("plays it inside its own trim window", async () => {
    await triggerWithFallback();

    const params = playbackMocks.playBuffer.mock.calls[0][2];
    expect(params.trimStart).toBe(0);
    expect(params.trimEnd).toBe(3);
  });

  it("tells the playback store which sound is actually playing", async () => {
    await triggerWithFallback();

    const params = playbackMocks.playBuffer.mock.calls[0][2];
    expect(params.multiSoundState.currentAudioFileId).toBe(GOOD);
    expect(params.multiSoundState.currentAudioIndex).toBe(1);
  });

  it("still plays the chosen sound normally when it loads", async () => {
    decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(fakeBuffer);

    await triggerWithFallback();

    const params = playbackMocks.playBuffer.mock.calls[0][2];
    expect(params.multiSoundState.currentAudioFileId).toBe(BROKEN);
    expect(params.trimStart).toBe(5);
    // -12 dB, the chosen sound's own setting.
    expect(params.volume).toBeLessThan(0.3);
  });
});
