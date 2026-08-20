/**
 * Layers in the playback engine.
 *
 * Runs against the shared Web Audio fake (`@/lib/testSupport/fakeWebAudio`),
 * the same one `playback.race.test.ts` uses: the only Web Audio the playback
 * module touches is `getAudioContext`, so a fake whose sources record their
 * `stop()` calls is enough to prove a source was silenced rather than dropped
 * from a map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createdSources,
  fakeAudioBuffer,
  fakeAudioContext,
  fakePlayParams,
  resetFakeWebAudio,
  stubAnimationFrame,
} from "@/lib/testSupport/fakeWebAudio";

vi.mock("./context", () => ({
  getAudioContext: () => fakeAudioContext,
}));

stubAnimationFrame();

const {
  playBuffer,
  stopTrack,
  stopInstance,
  stopAllTracks,
  allocateLayerKey,
  getLayerKeys,
  getActiveTrack,
  isTrackPlaying,
  isTrackFading,
  fadeOutInstance,
  fadeOutTrack,
  getStopGeneration,
  stopRequestedSince,
} = await import("./playback");
const { MAX_LAYERS_PER_PAD, makeInstanceKey, layerIndexOf, baseKeyOf } =
  await import("./types");

function play(key: string) {
  return playBuffer(fakeAudioBuffer, key, fakePlayParams(key));
}

/** Starts one more layer of a pad and returns the instance key it took. */
function playLayer(baseKey: string) {
  const key = allocateLayerKey(baseKey);
  play(key);
  return key;
}

beforeEach(() => {
  stopAllTracks();
  resetFakeWebAudio();
});

describe("two triggers on a pad set to layer", () => {
  it("leaves both instances live", () => {
    play("pad-1");
    playLayer("pad-1");

    expect(getLayerKeys("pad-1")).toHaveLength(2);
    const [first, second] = createdSources;
    expect(first.stopped).toBe(false);
    expect(second.stopped).toBe(false);
  });

  it("reports the pad as playing through its base key", () => {
    playLayer("pad-1");
    expect(isTrackPlaying("pad-1")).toBe(true);
  });

  it("hands the newest layer to getActiveTrack for the base key", () => {
    play("pad-1");
    const second = playLayer("pad-1");
    expect(getActiveTrack("pad-1")).toBe(getActiveTrack(second));
  });
});

describe("stopping a layered pad", () => {
  it("stops every instance from the base key", () => {
    play("pad-1");
    playLayer("pad-1");
    playLayer("pad-1");

    stopTrack("pad-1");

    expect(createdSources.every((source) => source.stopped)).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(0);
    expect(isTrackPlaying("pad-1")).toBe(false);
  });

  it("stops exactly one instance from stopInstance", () => {
    play("pad-1");
    const second = playLayer("pad-1");

    stopInstance(second);

    const [first, stopped] = createdSources;
    expect(stopped.stopped).toBe(true);
    expect(first.stopped).toBe(false);
    expect(getLayerKeys("pad-1")).toEqual(["pad-1"]);
  });

  it("fades every instance from the base key, not just one", () => {
    // This is what the Active Tracks panel's collapsed group row and its fade
    // button call: PadTrackGroup hands the row the pad's bare base key, so
    // this must reach every layer or the control silently fades only one.
    play("pad-1");
    const second = playLayer("pad-1");
    const third = playLayer("pad-1");

    const faded = fadeOutTrack("pad-1", 3);

    expect(faded).toBe(true);
    // A fade leaves every layer's track alive (only the gain ramps down) —
    // this is what tells a fade apart from a hard stop, which removes the
    // track from the registry entirely. Without this, the three
    // `fadeOutInstance(...) === false` checks below cannot tell "already
    // fading" from "no track at all": `fadeOutInstance` returns false for
    // both, so a `fadeOutTrack` that hard-stopped every layer instead of
    // fading it would pass them too.
    expect(getLayerKeys("pad-1")).toHaveLength(3);
    expect(isTrackFading("pad-1")).toBe(true);
    // fadeOutInstance is a no-op once a track is already fading, so a false
    // return for each instance's own key proves that exact instance was
    // marked — not merely the pad's aggregate view, which could stay true
    // even if only one of the three had actually started fading.
    expect(fadeOutInstance("pad-1", 3)).toBe(false);
    expect(fadeOutInstance(second, 3)).toBe(false);
    expect(fadeOutInstance(third, 3)).toBe(false);
  });

  it("reaches every layer from the panic button", () => {
    play("pad-1");
    playLayer("pad-1");
    play("pad-2");

    stopAllTracks();

    expect(createdSources.every((source) => source.stopped)).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(0);
    expect(getLayerKeys("pad-2")).toHaveLength(0);
  });
});

describe("a pad with one layer that fades", () => {
  it("still counts as playing while another layer is at full level", () => {
    play("pad-1");
    const second = playLayer("pad-1");

    fadeOutInstance(second, 3);

    expect(isTrackFading("pad-1")).toBe(false);
    expect(isTrackPlaying("pad-1")).toBe(true);
  });

  it("counts as fading once every layer fades", () => {
    play("pad-1");
    const first = "pad-1";
    const second = playLayer("pad-1");

    fadeOutInstance(first, 3);
    fadeOutInstance(second, 3);

    expect(isTrackFading("pad-1")).toBe(true);
  });
});

describe("stop generations resolve through the base key", () => {
  it("does not cancel a sibling pad's in-flight layer trigger", () => {
    // A trigger for pad-1 that is about to claim its second layer captures
    // the generation through the *instance* key it will register under,
    // before the key exists in any map.
    const pendingKey = allocateLayerKey("pad-1");
    play("pad-1"); // pad-1's first layer is already live
    const captured = getStopGeneration(pendingKey);

    // Something entirely unrelated stops a different pad.
    play("pad-2");
    stopTrack("pad-2");

    expect(stopRequestedSince(pendingKey, captured)).toBe(false);
  });

  it("cancels an in-flight layer trigger when its own pad is stopped by its base key", () => {
    const pendingKey = allocateLayerKey("pad-1");
    play("pad-1");
    const captured = getStopGeneration(pendingKey);

    // The pad is stopped through its bare base key — the shape the panic
    // button and the Active Tracks row's collapsed row both use — while the
    // capture happened through an instance key of the same pad.
    stopTrack("pad-1");

    expect(stopRequestedSince(pendingKey, captured)).toBe(true);
  });
});

describe("the layer cap", () => {
  it("stops the oldest layer at the 17th trigger and holds the count at 16", () => {
    play("pad-1");
    for (let i = 1; i < MAX_LAYERS_PER_PAD; i++) {
      playLayer("pad-1");
    }
    expect(getLayerKeys("pad-1")).toHaveLength(MAX_LAYERS_PER_PAD);

    const oldest = createdSources[0];
    playLayer("pad-1");

    expect(oldest.stopped).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(MAX_LAYERS_PER_PAD);
  });

  it("never reuses a layer number for one pad", () => {
    // `nextLayerIndex` is a module-level counter that is deliberately never
    // reset (see playback.ts), so its absolute value depends on how many
    // layers of "pad-1" earlier tests in this file allocated. What this test
    // owns is the *shape* of the guarantee — the number strictly increases
    // and is never handed out twice — not a literal index, which a sibling
    // test bumping the counter first would make order-dependent for no
    // behavioural reason.
    const first = playLayer("pad-1");
    stopTrack("pad-1");
    const second = playLayer("pad-1");

    expect(second).not.toBe(first);
    expect(second).toBe(makeInstanceKey("pad-1", layerIndexOf(first) + 1));
  });
});

describe("allocateLayerKey normalises its argument", () => {
  it("keys a new layer to the pad's base even when passed an instance key", () => {
    // Every sibling of allocateLayerKey (getLayerKeys, stopTrack,
    // fadeOutTrack, isTrackPlaying, ...) accepts a base key or any instance
    // key of the pad. A caller can plausibly hold an instance key already —
    // e.g. its own trigger's freshly claimed key — and pass that on, so
    // allocateLayerKey must resolve it to the pad's real base key rather
    // than minting a layer under a phantom base like "pad-1#1".
    const first = allocateLayerKey("pad-1");
    play(first);

    const second = allocateLayerKey(first);
    play(second);

    expect(baseKeyOf(second)).toBe("pad-1");
    // An un-normalised allocateLayerKey would key the second layer to the
    // phantom base baseKeyOf(first) taken as a *literal* map key — but
    // getLayerKeys itself normalises through baseKeyOf too, so the only way
    // to see that phantom base is to have never scoped this assertion to it
    // in the first place: the pad's real registry containing both keys, in
    // allocation order, is the direct evidence that allocateLayerKey wrote
    // to "pad-1" and not to "pad-1#1".
    expect(getLayerKeys("pad-1")).toEqual([first, second]);
  });
});
