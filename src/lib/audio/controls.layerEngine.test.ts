/**
 * "Layer", from a trigger to the sounds it leaves running.
 *
 * `controls.layer.test.ts` mocks the playback module, so it can only show
 * which key the trigger *asked* to play on. Every gate on this branch so far
 * has been of that kind, and a reviewer proved the point by reverting the
 * union member that started it all: nothing went red, because nothing outside
 * `db.ts` referenced it.
 *
 * So this file mocks nothing below `controls` except the Web Audio context
 * itself. The real playback engine registers the instances, the real
 * `playbackStore` collects them, and the assertions are on `getLayerKeys` and
 * on `groupPlaybackByPad` — the exact fold the Active Tracks panel renders.
 * Two triggers have to leave two sounds running, the seventeenth has to leave
 * sixteen, and the pad's own base key has to still reach all of them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePadBehavior } from "@/lib/db";

/**
 * The Web Audio surface `playback.ts` touches, and nothing else.
 *
 * Deliberately not the fake from `playback.race.test.ts`: this suite never
 * inspects a node, because what a layer *is* here is a live entry in the
 * engine's registry and in the store. A source only has to be constructible
 * and connectable — `playBuffer` swallows its own errors and returns null, so
 * a fake that were missing a method would show up as "nothing ever played".
 */
const audioParam = () => ({
  value: 1,
  setValueAtTime: () => audioParam(),
  cancelScheduledValues: () => audioParam(),
  linearRampToValueAtTime: () => audioParam(),
});

const noopNode = () => ({
  connect: () => {},
  disconnect: () => {},
});

const fakeContext = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createBufferSource: () => ({
    ...noopNode(),
    buffer: null,
    onended: null,
    start: () => {},
    stop: () => {},
  }),
  createGain: () => ({ ...noopNode(), gain: audioParam() }),
};

const profileBehavior = vi.hoisted(() => ({ value: "continue" }));

vi.mock("./context", () => ({
  getAudioContext: () => fakeContext,
  resumeAudioContext: async () => {},
}));
// The fast path in `triggerAudioForPadInstant`: a decoded buffer is already
// cached, so the trigger reaches `playBuffer` without a database read.
vi.mock("./cache", () => ({
  getCachedAudioBuffer: () => ({ duration: 30, numberOfChannels: 2 }),
  clearCachedAudioBuffer: () => {},
  invalidateCachedAudioBuffer: () => {},
}));
vi.mock("./decoder", () => ({
  loadAndDecodeAudioInstant: vi.fn(),
  loadAndDecodeAudioEnhanced: vi.fn(),
}));
vi.mock("./preloader", () => ({
  audioPreloader: { trackPlayedFile: () => {} },
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({
      getActivePadBehavior: () => profileBehavior.value,
      getNormalisationSettings: () => ({ enabled: false, targetLufs: -23 }),
    }),
  },
}));

globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

const { triggerAudioForPadInstant, stopAudio, fadeOutAudio } =
  await import("./controls");
const { getLayerKeys, stopAllTracks, isTrackPlaying, isTrackFading } =
  await import("./playback");
const { MAX_LAYERS_PER_PAD, generatePlaybackKey } = await import("./types");
const { usePlaybackStore, groupPlaybackByPad } =
  await import("@/store/playbackStore");

const SOUND = 400;

// One pad per test. Both the strategy cursors and the engine's layer numbering
// are module-level and outlive a test, so a shared pad index would make these
// assertions depend on what ran before them.
let nextPadIndex = 0;

beforeEach(() => {
  stopAllTracks();
  usePlaybackStore.setState({ activePlayback: new Map() });
  profileBehavior.value = "continue";
});

/** A pad of its own, and the base key its sounds belong to. */
function freshPad(): { padIndex: number; baseKey: string } {
  const padIndex = nextPadIndex++;
  return { padIndex, baseKey: generatePlaybackKey(1, "0", padIndex) };
}

/** Presses a pad once, the way a key press or a click eventually does. */
async function press(
  padIndex: number,
  activePadBehavior: ActivePadBehavior | undefined,
): Promise<void> {
  await triggerAudioForPadInstant({
    padIndex,
    audioFileIds: [SOUND],
    playbackType: "sequential",
    activeProfileId: 1,
    currentBankId: "0",
    name: "Applause",
    audioGainSettings: undefined,
    padGainDb: 0,
    activePadBehavior,
  });
}

/** The pad's row in the Active Tracks panel, folded exactly as the UI folds it. */
function groupFor(baseKey: string) {
  const groups = groupPlaybackByPad(usePlaybackStore.getState().activePlayback);
  return groups.find((group) => group.baseKey === baseKey);
}

describe("one press of a silent pad", () => {
  it("registers exactly one sound, under the pad's bare base key", async () => {
    // Also the smoke test for the fake context above: every other assertion
    // in this file needs a sound to have actually started, and `playBuffer`
    // reports a failure by quietly returning null.
    const { padIndex, baseKey } = freshPad();

    await press(padIndex, "layer");

    expect(getLayerKeys(baseKey)).toEqual([baseKey]);
    expect(isTrackPlaying(baseKey)).toBe(true);
  });
});

describe("a second press of a pad set to layer", () => {
  it("leaves two sounds running instead of one", async () => {
    const { padIndex, baseKey } = freshPad();

    await press(padIndex, "layer");
    await press(padIndex, "layer");

    const keys = getLayerKeys(baseKey);
    expect(keys).toHaveLength(2);
    // The first sound is still the one under the bare base key: the second
    // press took a new instance key rather than displacing it.
    expect(keys[0]).toBe(baseKey);
    expect(keys[1]).not.toBe(baseKey);
    expect(keys[1].startsWith(`${baseKey}#`)).toBe(true);
  });

  it("shows the pad as one row with two layers in Active Tracks", async () => {
    const { padIndex, baseKey } = freshPad();

    await press(padIndex, "layer");
    await press(padIndex, "layer");

    const group = groupFor(baseKey);
    expect(group?.layers).toHaveLength(2);
    expect(group?.newest.key).toBe(getLayerKeys(baseKey)[1]);
    // One row, not two: the panel must not grow a second entry for the pad.
    expect(
      groupPlaybackByPad(usePlaybackStore.getState().activePlayback),
    ).toHaveLength(1);
  });

  it("does not layer when the pad says anything else", async () => {
    // The same two presses under the other three behaviours, so the test above
    // is measuring "layer" rather than measuring two presses.
    for (const behavior of ["continue", "stop", "restart"] as const) {
      const { padIndex, baseKey } = freshPad();

      await press(padIndex, behavior);
      await press(padIndex, behavior);

      expect(getLayerKeys(baseKey).length).toBeLessThanOrEqual(1);
    }
  });

  it("follows a profile default of layer when the pad says nothing", async () => {
    profileBehavior.value = "layer";
    const { padIndex, baseKey } = freshPad();

    await press(padIndex, undefined);
    await press(padIndex, undefined);

    expect(getLayerKeys(baseKey)).toHaveLength(2);
  });

  it("obeys the pad over a profile that says stop", async () => {
    profileBehavior.value = "stop";
    const { padIndex, baseKey } = freshPad();

    await press(padIndex, "layer");
    await press(padIndex, "layer");

    expect(getLayerKeys(baseKey)).toHaveLength(2);
  });
});

describe("pressing a layering pad past the cap", () => {
  it("holds at 16 sounds and drops the oldest", async () => {
    const { padIndex, baseKey } = freshPad();

    for (let press_ = 0; press_ < MAX_LAYERS_PER_PAD; press_++) {
      await press(padIndex, "layer");
    }
    const full = getLayerKeys(baseKey);
    expect(full).toHaveLength(MAX_LAYERS_PER_PAD);

    await press(padIndex, "layer");

    const after = getLayerKeys(baseKey);
    expect(after).toHaveLength(MAX_LAYERS_PER_PAD);
    // The oldest is gone and the survivors kept their order, so the cap stole
    // a layer rather than refusing the press or renumbering the stack.
    expect(after).not.toContain(full[0]);
    expect(after.slice(0, MAX_LAYERS_PER_PAD - 1)).toEqual(full.slice(1));
    // The stolen layer left the panel too, or the row would count 17.
    expect(groupFor(baseKey)?.layers).toHaveLength(MAX_LAYERS_PER_PAD);
    // And the press still made a sound, which is the whole reason the cap
    // steals rather than refuses.
    expect(after[MAX_LAYERS_PER_PAD - 1]).not.toBe(
      full[MAX_LAYERS_PER_PAD - 1],
    );
  });
});

describe("the Active Tracks row's own controls, now that a pad really stacks", () => {
  // `PadTrackGroup` hands the collapsed row's stop and fade buttons the pad's
  // BARE base key. That only works because `stopTrack`/`fadeOutTrack`
  // normalise, and until now no pad had more than one instance for them to
  // reach. This is the first time the two meet.
  it("stops every layer from the bare base key", async () => {
    const { padIndex, baseKey } = freshPad();
    await press(padIndex, "layer");
    await press(padIndex, "layer");
    await press(padIndex, "layer");

    stopAudio(baseKey);

    expect(getLayerKeys(baseKey)).toEqual([]);
    expect(isTrackPlaying(baseKey)).toBe(false);
    expect(groupFor(baseKey)).toBeUndefined();
  });

  it("fades every layer from the bare base key, without stopping any", async () => {
    const { padIndex, baseKey } = freshPad();
    await press(padIndex, "layer");
    await press(padIndex, "layer");
    await press(padIndex, "layer");

    fadeOutAudio(baseKey, 3);

    // A fade leaves the layers registered and ramps them down; a hard stop
    // would empty the registry. Asserting only "is fading" cannot tell those
    // apart, because a pad with no layers left is not fading either.
    expect(getLayerKeys(baseKey)).toHaveLength(3);
    expect(isTrackFading(baseKey)).toBe(true);
    // `isTrackFading` for the pad is an AND over its layers, so this is the
    // half that proves the third one was reached and not just the first.
    expect(groupFor(baseKey)?.isFading).toBe(true);
  });
});
