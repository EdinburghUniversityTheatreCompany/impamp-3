/**
 * The trigger path, with everything below `controls` stubbed.
 *
 * One fixture for two findings, because they need exactly the same one: the
 * whole audio stack faked down to the decoder, the playback module and the
 * database, so a trigger can be walked step by step. Splitting them across two
 * files meant the fixture written twice, which is a second place for "what a
 * trigger sees" to drift.
 *
 * ---
 *
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
import { mockAudioStack } from "@/lib/testSupport/audioStackMocks";
import type { LoadingState } from "./decoder";

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
// The cache, the context, the database, the preloader and the profile store,
// stubbed the same way `controls.layer.test.ts` stubs them. This suite never
// varies the profile behaviour, so it takes the default of "continue".
mockAudioStack();

const { triggerAudioForPadInstant } = await import("./controls");
const { triggerPad } = await import("./triggerPad");
const { useLoadingStore, generatePadLoadingKey } =
  await import("@/store/loadingStore");

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
    currentBankId: "0",
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
    expect(params.multiSoundState.currentAudioIndex).toBe(0);
  });

  /**
   * The fallback landing on index 0, which is the one case that separates
   * `playingIndex >= 0` from `playingIndex > 0`.
   *
   * Everywhere else the two agree: when the first sound plays, `playingIndex`
   * and the strategy's `index` are both 0, so the fallback expression returns
   * 0 either way. It takes a strategy that chose a *later* sound and a
   * fallback that landed on the first one for `> 0` to answer with the index
   * of the sound that did not play — which is what the Active Tracks panel
   * would then show, and what a "next sound" would advance from.
   */
  it("reports index 0 when the fallback is the pad's first sound", async () => {
    const padIndex = nextPadIndex++;
    // First sound good, second broken — the reverse of the pad above.
    const play = () =>
      triggerAudioForPadInstant({
        padIndex,
        audioFileIds: [GOOD, BROKEN],
        playbackType: "sequential",
        activeProfileId: 1,
        currentBankId: "0",
        name: "Pad",
        audioGainSettings: {},
        padGainDb: 0,
      });

    // First press takes the sequential cursor to the second sound.
    await play();
    expect(
      playbackMocks.playBuffer.mock.calls[0][2].multiSoundState
        .currentAudioIndex,
    ).toBe(0);

    // Second press chooses index 1, which fails, and falls back to index 0.
    playbackMocks.isTrackPlaying.mockReturnValue(false);
    await play();

    const params = playbackMocks.playBuffer.mock.calls[1][2];
    expect(params.multiSoundState.currentAudioFileId).toBe(GOOD);
    expect(params.multiSoundState.currentAudioIndex).toBe(0);
  });
});

/**
 * `loadAndDecodeAudioInstant` reports a loading state before it does anything,
 * and `triggerPad` forwards that to the shared loading store, which is what
 * mounts the spinner over the pad. Only two things cleared it again:
 * `onAudioReady` and `onError`. The cancellation branches call neither — they
 * simply `return`, because nothing is audible and nothing failed — so pressing
 * ESC during a slow load left the entry behind. The leftover status is
 * "ready", so none of the overlay's three text branches match either: the pad
 * shows a bare spinner over a full progress bar, and nothing clears it but a
 * later successful trigger of that same pad.
 */
function loadingStateFor(padIndex: number) {
  return useLoadingStore
    .getState()
    .padLoadingStates.get(generatePadLoadingKey(1, "0", padIndex));
}

/** Triggers a pad whose decode reports a loading state before it resolves. */
async function triggerReportingProgress(): Promise<number> {
  const padIndex = nextPadIndex++;
  await triggerPad(
    {
      padIndex,
      audioFileIds: [GOOD],
      playbackType: "sequential",
      name: "Pad",
    },
    { activeProfileId: 1, currentBankId: "0" },
  );
  return padIndex;
}

describe("the pad's loading overlay", () => {
  beforeEach(() => {
    useLoadingStore.getState().actions.clearAllLoadingStates();
    decoderMocks.loadAndDecodeAudioInstant.mockImplementation(
      async (
        audioFileId: number,
        onStateChange?: (state: LoadingState) => void,
      ) => {
        onStateChange?.({
          audioFileId,
          status: "loading",
          progress: 0,
          startTime: 0,
        });
        return fakeBuffer;
      },
    );
  });

  it("comes down when a stop cancels the load", async () => {
    // False at the check after the blob read, true at the one after the
    // decode: ESC landed while the file was being decoded, which is an
    // ordinary thing to do during a slow load.
    playbackMocks.stopRequestedSince
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    const padIndex = await triggerReportingProgress();

    expect(playbackMocks.playBuffer).not.toHaveBeenCalled();
    expect(loadingStateFor(padIndex)).toBeUndefined();
  });

  it("comes down when the stop lands before the decode even starts", async () => {
    playbackMocks.stopRequestedSince.mockReturnValue(true);

    const padIndex = await triggerReportingProgress();

    expect(loadingStateFor(padIndex)).toBeUndefined();
  });

  it("comes down when the sound plays", async () => {
    const padIndex = await triggerReportingProgress();

    expect(playbackMocks.playBuffer).toHaveBeenCalledTimes(1);
    expect(loadingStateFor(padIndex)).toBeUndefined();
  });

  it("stays up as an error when nothing could be loaded at all", async () => {
    // The one ending that does not clear at once. This case used to assert
    // the overlay came down here too, which pinned the bug: a press whose
    // sound could not be loaded looked exactly like a press nobody made.
    // How long it stays, and that it does come down, is `triggerPad.test.ts`'s
    // business — this file runs the real recovery path, whose retry delays
    // do not mix with fake timers.
    decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(null);
    decoderMocks.loadAndDecodeAudioEnhanced.mockResolvedValue(null);

    const padIndex = await triggerReportingProgress();

    expect(loadingStateFor(padIndex)).toMatchObject({ status: "error" });
  });
});

describe("reporting a press that failed", () => {
  it("reports a total failure to onError exactly once", async () => {
    // `handleAudioFallback` used to call `onError` itself when recovery came
    // back empty, and its one caller then reported the same null again. Two
    // callbacks for one failure was invisible while `onError` only wrote to
    // the console; once it posts a notice, the operator got two boxes for one
    // press — measured in `e2e-tests/error-notices.spec.ts` as a strict-mode
    // violation on the notice locator.
    decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(null);
    decoderMocks.loadAndDecodeAudioEnhanced.mockResolvedValue(null);
    const onError = vi.fn();

    await triggerPad(
      {
        padIndex: nextPadIndex++,
        audioFileIds: [GOOD],
        playbackType: "sequential",
        name: "Pad",
      },
      { activeProfileId: 1, currentBankId: "0" },
      { onError },
    );

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
