/**
 * The retrigger switch, with "layer" added.
 *
 * Everything below `controls` is stubbed, exactly as in `controls.trigger.test.ts`,
 * so the decision itself can be watched: which key playback is asked to play on,
 * and which pad the playback strategy is asked about.
 *
 * What this file does NOT prove is that a second sound actually starts — the
 * playback module is a mock here, so `allocateLayerKey` returns whatever this
 * file says it does. `controls.layerEngine.test.ts` runs the same decision
 * against the real engine and asserts on the live instances it leaves behind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockAudioStack } from "@/lib/testSupport/audioStackMocks";
import type { ActivePadBehavior } from "@/lib/db";

// Only what `controls` imports from the decoder: the instant path this file
// plays through, and the enhanced one its fallback reaches for.
const decoderMocks = vi.hoisted(() => ({
  loadAndDecodeAudioInstant: vi.fn(),
  loadAndDecodeAudioEnhanced: vi.fn(),
}));

const playbackMocks = vi.hoisted(() => ({
  playBuffer: vi.fn(),
  playBlobStreaming: vi.fn(),
  waitForStreamingPlayable: vi.fn(),
  stopTrack: vi.fn(),
  stopInstance: vi.fn(),
  fadeOutTrack: vi.fn(),
  fadeOutInstance: vi.fn(),
  stopAllTracks: vi.fn(),
  fadeOutAllTracks: vi.fn(),
  isTrackPlaying: vi.fn(() => false),
  isTrackFading: vi.fn(() => false),
  getActiveTrack: vi.fn(() => null),
  getStopGeneration: vi.fn<(key: string) => { global: number; key: number }>(
    () => ({ global: 0, key: 0 }),
  ),
  // Typed with the real signature so `mock.calls` is a `[string, ...]` tuple:
  // the assertion below reads the key out of every call.
  stopRequestedSince: vi.fn<
    (key: string, generation: { global: number; key: number }) => boolean
  >(() => false),
  allocateLayerKey: vi.fn((base: string) => `${base}#1`),
  clampTrimRange: vi.fn((s: number, e: number) => ({
    trimStart: s,
    trimEnd: e,
  })),
}));

const dbMocks = vi.hoisted(() => ({
  getAudioFile: vi.fn(async (): Promise<{ blob: Blob } | null> => null),
}));

const profileBehavior = vi.hoisted(() => ({ value: "continue" }));

// The loudness cache is deliberately NOT stubbed: it is an in-memory Map, and
// an unmeasured sound is exactly what these pads are. Nothing here asserts on
// level, so the real one answers undefined and `resolveGain` falls through.
vi.mock("./decoder", () => decoderMocks);
vi.mock("./playback", () => playbackMocks);
// The cache, the context, the database, the preloader and the profile store.
// `profileBehavior` is read on every call, so a test can change the profile's
// answer between triggers; `dbMocks` is overlaid so this suite keeps a handle
// on `getAudioFile` and can drive it per test.
mockAudioStack({
  activePadBehavior: () => profileBehavior.value as ActivePadBehavior,
  db: dbMocks,
});

const { triggerAudioForPadInstant } = await import("./controls");
const { getStrategy } = await import("./strategies");

const SOUND_A = 300;
const SOUND_B = 301;
const fakeBuffer = { duration: 3, numberOfChannels: 2 } as AudioBuffer;

// Playback strategies are keyed by playback key and persist for the life of
// the module, so each test gets its own pad rather than inheriting whichever
// sound the previous test's sequential cursor landed on.
let nextPadIndex = 0;

beforeEach(() => {
  vi.clearAllMocks();
  profileBehavior.value = "continue";
  playbackMocks.isTrackPlaying.mockReturnValue(true);
  playbackMocks.isTrackFading.mockReturnValue(false);
  playbackMocks.stopRequestedSince.mockReturnValue(false);
  playbackMocks.allocateLayerKey.mockImplementation(
    (base: string) => `${base}#1`,
  );
  decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(fakeBuffer);
  // No blob, so the streaming path is skipped and the decode fallback plays.
  dbMocks.getAudioFile.mockResolvedValue(null);
});

/** Triggers a pad that is already live, with the given per-pad override. */
async function triggerLivePad(
  activePadBehavior: ActivePadBehavior | undefined,
) {
  const padIndex = nextPadIndex++;
  await triggerAudioForPadInstant({
    padIndex,
    audioFileIds: [SOUND_A, SOUND_B],
    playbackType: "sequential",
    activeProfileId: 1,
    currentBankId: "0",
    name: "Applause",
    audioGainSettings: undefined,
    padGainDb: 0,
    activePadBehavior,
  });
  return `pad-1-0-${padIndex}`;
}

describe("a pad set to layer", () => {
  it("plays the new sound on an instance key, not the base key", async () => {
    const base = await triggerLivePad("layer");

    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
    expect(playbackMocks.playBuffer).toHaveBeenCalledTimes(1);
    expect(playbackMocks.playBuffer.mock.calls[0][1]).toBe(`${base}#1`);
  });

  it("stops nothing", async () => {
    await triggerLivePad("layer");
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
    expect(playbackMocks.stopInstance).not.toHaveBeenCalled();
  });

  it("advances the pad's one strategy cursor per layer", async () => {
    const base = await triggerLivePad("layer");
    const first = playbackMocks.playBuffer.mock.calls[0][2];

    playbackMocks.allocateLayerKey.mockReturnValue(`${base}#2`);
    await triggerAudioForPadInstant({
      padIndex: Number(base.split("-")[3]),
      audioFileIds: [SOUND_A, SOUND_B],
      playbackType: "sequential",
      activeProfileId: 1,
      currentBankId: "0",
      name: "Applause",
      audioGainSettings: undefined,
      padGainDb: 0,
      activePadBehavior: "layer",
    });
    const second = playbackMocks.playBuffer.mock.calls[1][2];

    // One cursor per pad, so the second layer is a different sound.
    expect(first.multiSoundState.currentAudioFileId).toBe(SOUND_A);
    expect(second.multiSoundState.currentAudioFileId).toBe(SOUND_B);
  });

  it("asks the strategy about the pad, never about the layer", async () => {
    const base = await triggerLivePad("layer");
    // A strategy instance is created per key; asking for the base key must give
    // back the same instance the trigger advanced.
    const strategy = getStrategy("sequential", base);
    expect(strategy.selectNextSound([SOUND_A, SOUND_B]).audioFileId).toBe(
      SOUND_B,
    );
  });

  it("watches the pad's own stop generation, not the layer's", async () => {
    // The generation guards the load: a stop of this pad, by any key, has to
    // cancel a layer that is still loading. Both the capture and every check
    // therefore have to name the base key — a capture on the fresh instance
    // key would see its own private counter and never notice the pad's.
    const base = await triggerLivePad("layer");

    expect(playbackMocks.getStopGeneration).toHaveBeenCalledWith(base);
    expect(playbackMocks.getStopGeneration).not.toHaveBeenCalledWith(
      `${base}#1`,
    );
    for (const [key] of playbackMocks.stopRequestedSince.mock.calls) {
      expect(key).toBe(base);
    }
    // A trigger that never consulted the generation at all would pass the two
    // negatives above, so pin that it did.
    expect(playbackMocks.stopRequestedSince).toHaveBeenCalled();
  });
});

describe("a layer whose stream will not start", () => {
  beforeEach(() => {
    // The blob is there and the media element is created, but it never
    // becomes playable — the case that falls back to decoding the file.
    dbMocks.getAudioFile.mockResolvedValue({ blob: {} as Blob });
    playbackMocks.playBlobStreaming.mockReturnValue({} as HTMLAudioElement);
    playbackMocks.waitForStreamingPlayable.mockResolvedValue(false);
    playbackMocks.getActiveTrack.mockReturnValue(null);
  });

  it("releases that layer alone, and lets the pad's others sound on", async () => {
    const base = await triggerLivePad("layer");

    // Releasing the whole pad here would silence every other layer of it
    // because one layer's stream failed to start.
    expect(playbackMocks.stopInstance).toHaveBeenCalledWith(`${base}#1`);
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
    // And the fallback still played this layer, on its own key.
    expect(playbackMocks.playBuffer.mock.calls[0][1]).toBe(`${base}#1`);
  });

  it("re-baselines the pad's stop generation, not the layer's", async () => {
    // The release above is this trigger's own bookkeeping stop, so the
    // generation has to be re-read or the decode fallback below reads it as
    // a user-requested stop and cancels itself. Re-reading the *layer's*
    // counter would leave the pad's own stop invisible from here on.
    const base = await triggerLivePad("layer");

    expect(playbackMocks.getStopGeneration).toHaveBeenCalledTimes(2);
    for (const [key] of playbackMocks.getStopGeneration.mock.calls) {
      expect(key).toBe(base);
    }
  });
});

describe("the per-pad override against the profile default", () => {
  it("beats the profile default", async () => {
    profileBehavior.value = "stop";
    const base = await triggerLivePad("layer");
    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
  });

  it("follows the profile default when the pad says nothing", async () => {
    profileBehavior.value = "layer";
    const base = await triggerLivePad(undefined);
    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
  });

  it("still stops the pad when the profile says stop", async () => {
    profileBehavior.value = "stop";
    const base = await triggerLivePad(undefined);
    expect(playbackMocks.stopTrack).toHaveBeenCalledWith(base);
    expect(playbackMocks.playBuffer).not.toHaveBeenCalled();
  });

  it("still restarts the pad when the pad says restart", async () => {
    const base = await triggerLivePad("restart");
    expect(playbackMocks.stopTrack).toHaveBeenCalledWith(base);
    expect(playbackMocks.playBuffer.mock.calls[0][1]).toBe(base);
    expect(playbackMocks.allocateLayerKey).not.toHaveBeenCalled();
  });
});

/**
 * A behaviour value this build has never heard of.
 *
 * No runtime schema validates `activePadBehavior` anywhere on the sync or the
 * import path, so a profile written by a newer client can hand an older one a
 * value that is not in its union. The decision to ship no compatibility shim
 * rests entirely on this arm: the pad must go on behaving as it does today
 * rather than throwing or falling through into playback.
 *
 * The cast is the point of the test. TypeScript makes the arm unreachable, so
 * only a deliberately out-of-union value can exercise it, and until this
 * existed the arm could be replaced with `throw` without reddening anything.
 */
const UNKNOWN = "crossfade" as ActivePadBehavior;

describe("an activePadBehavior this build does not know", () => {
  it("leaves the pad alone rather than throwing", async () => {
    // Resolving at all is half the assertion: a `default` arm that threw —
    // the exact "an older client chokes on a value from a newer one" failure
    // this arm exists to prevent — would reject here.
    await expect(triggerLivePad(UNKNOWN)).resolves.toBeTypeOf("string");

    expect(playbackMocks.playBuffer).not.toHaveBeenCalled();
    expect(playbackMocks.playBlobStreaming).not.toHaveBeenCalled();
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
    expect(playbackMocks.allocateLayerKey).not.toHaveBeenCalled();
  });

  it("says which value it did not recognise", async () => {
    // The only thing that separates this arm from `continue`, which is also
    // silent and also plays nothing. Without it the test above passes just as
    // happily against a switch whose `default` was deleted and whose unknown
    // values fall into `case "continue"`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await triggerLivePad(UNKNOWN);
      const said = warn.mock.calls.map((call) => String(call[0]));
      expect(said.some((line) => line.includes(UNKNOWN))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("is refused from the profile default too", async () => {
    profileBehavior.value = UNKNOWN;
    await expect(triggerLivePad(undefined)).resolves.toBeTypeOf("string");
    expect(playbackMocks.playBuffer).not.toHaveBeenCalled();
  });

  it("does not block a pad that is not playing yet", async () => {
    // The switch is inside `if (isAlreadyPlaying)`, so an unrecognised value
    // must not stop a silent pad from making its first sound.
    playbackMocks.isTrackPlaying.mockReturnValue(false);
    const base = await triggerLivePad(UNKNOWN);
    expect(playbackMocks.playBuffer.mock.calls[0][1]).toBe(base);
  });
});
