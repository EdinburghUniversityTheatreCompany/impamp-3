/**
 * A streamed track's trim end, when nothing is painting frames (🟡 A2).
 *
 * Buffer playback gets its trim natively — `source.start(0, trimStart,
 * trimmedDuration)` is scheduled on the audio thread and holds whatever the
 * main thread is doing. A media element has no equivalent, so the end point
 * used to be policed from `playbackLoopTick`, which is scheduled purely by
 * `requestAnimationFrame`. Browsers do not run rAF in a hidden tab, and
 * `context.ts` deliberately keeps audio playing when the tab is hidden, so
 * switching windows mid-cue turned a trimmed sound into the whole file — and
 * the untrimmed tail is usually the part that was trimmed off because it is
 * unwanted.
 *
 * Every test here leaves `requestAnimationFrame` as a stub that never calls
 * its callback. That is the hidden tab, exactly: the audio clock and timers
 * keep running, frames do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayAudioParams } from "./types";

interface ScheduledRamp {
  value: number;
  time: number;
}

class FakeAudioParam {
  value = 1;
  readonly ramps: ScheduledRamp[] = [];
  readonly holds: ScheduledRamp[] = [];
  cancelledAt: number[] = [];

  setValueAtTime(value: number, time: number) {
    this.holds.push({ value, time });
    return this;
  }
  cancelScheduledValues(time: number) {
    this.cancelledAt.push(time);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.ramps.push({ value, time });
    return this;
  }
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect() {}
  disconnect() {}
}

const createdGainNodes: FakeGainNode[] = [];

const fakeContext = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createGain() {
    const node = new FakeGainNode();
    createdGainNodes.push(node);
    return node;
  },
  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  },
};

vi.mock("./context", () => ({
  getAudioContext: () => fakeContext,
}));

type Listener = (event?: unknown) => void;

/** Enough of an `HTMLAudioElement` for the streaming path, driven by hand. */
class FakeAudioElement {
  static instances: FakeAudioElement[] = [];

  currentTime = 0;
  duration = NaN;
  paused = false;
  preload = "";
  src = "";
  readyState = 0;
  error: unknown = null;
  onended: Listener | null = null;
  onerror: Listener | null = null;
  playCalls = 0;
  loadCalls = 0;

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    FakeAudioElement.instances.push(this);
  }

  addEventListener(type: string, listener: Listener, options?: unknown) {
    const wrapped =
      options && (options as { once?: boolean }).once
        ? (event?: unknown) => {
            this.removeEventListener(type, wrapped);
            listener(event);
          }
        : listener;
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(wrapped);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  play() {
    this.playCalls++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loadCalls++;
  }
  removeAttribute() {}
}

// The hidden tab: frames never arrive, so anything that depends on one never
// happens. Timers and the audio clock keep running, which is what the fix uses.
globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
globalThis.Audio = FakeAudioElement as unknown as typeof Audio;
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};

const { playBlobStreaming, isTrackPlaying, stopTrack, stopAllTracks } =
  await import("./playback");

function stream(key: string, trim: { trimStart?: number; trimEnd?: number }) {
  return playBlobStreaming(new Blob(), key, {
    name: key,
    volume: 1,
    ...trim,
    padInfo: { profileId: 1, bankId: "0", padIndex: 0 },
    multiSoundState: {
      playbackType: "sequential",
      allAudioFileIds: [1],
      currentAudioFileId: 1,
      currentAudioIndex: 0,
    },
  } as PlayAudioParams);
}

/** Plays a 10-second file trimmed to end at `trimEnd`, metadata and all. */
function streamTrimmed(key: string, trimEnd: number | undefined) {
  stream(key, { trimStart: 0, trimEnd });
  const element = FakeAudioElement.instances.at(-1)!;
  element.duration = 10;
  element.dispatch("loadedmetadata");
  element.dispatch("playing");
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
  stopAllTracks();
  fakeContext.currentTime = 0;
  FakeAudioElement.instances.length = 0;
  createdGainNodes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a streamed track with a trim end", () => {
  it("schedules the cut on the audio clock rather than waiting for a frame", () => {
    streamTrimmed("pad-1", 2);

    // The audio thread honours this whatever the main thread is doing, which
    // is the only way the cut can be exact in a tab that is not painting.
    const gain = createdGainNodes.at(-1)!.gain;
    const cut = gain.ramps.find((ramp) => ramp.value === 0);
    expect(cut).toBeDefined();
    expect(cut!.time).toBeCloseTo(2, 5);
  });

  it("ends the track at the trim point with no frames at all", async () => {
    streamTrimmed("pad-1", 2);
    expect(isTrackPlaying("pad-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(2100);

    // Policed only from rAF, this plays on to the natural end of the file and
    // is cut off whenever the tab is next looked at.
    expect(isTrackPlaying("pad-1")).toBe(false);
  });

  it("releases the element rather than leaving it playing silently", async () => {
    const element = streamTrimmed("pad-1", 2);

    await vi.advanceTimersByTimeAsync(2100);

    expect(element.paused).toBe(true);
  });

  it("does not cut early while the trim point is still ahead", async () => {
    streamTrimmed("pad-1", 5);

    await vi.advanceTimersByTimeAsync(4000);

    expect(isTrackPlaying("pad-1")).toBe(true);
  });

  it("measures from where playback actually is, not from where it started", () => {
    stream("pad-1", { trimStart: 3, trimEnd: 8 });
    const element = FakeAudioElement.instances.at(-1)!;
    element.duration = 10;
    element.dispatch("loadedmetadata");
    element.dispatch("playing");

    // `loadedmetadata` seeks to trimStart, so the remaining window is five
    // seconds, not eight. Scheduling from the trim end alone would run the
    // untrimmed head-start straight into the tail.
    const gain = createdGainNodes.at(-1)!.gain;
    const cut = gain.ramps.find((ramp) => ramp.value === 0);
    expect(cut!.time).toBeCloseTo(5, 5);
  });
});

describe("a streamed track with no trim end", () => {
  it("is left to finish on its own", async () => {
    streamTrimmed("pad-1", undefined);

    await vi.advanceTimersByTimeAsync(60_000);

    // Nothing scheduled means nothing to get wrong: the element's own `ended`
    // event is what finishes an untrimmed sound.
    expect(isTrackPlaying("pad-1")).toBe(true);
  });
});

describe("a scheduled cut and the key it was scheduled for", () => {
  it("cannot end a later track that took the key over", async () => {
    streamTrimmed("pad-1", 2);
    stopTrack("pad-1");

    streamTrimmed("pad-1", 30);
    await vi.advanceTimersByTimeAsync(2100);

    // The first track's deadline is still in the future when the pad is
    // retriggered. A cut that fires by key rather than by identity would take
    // the replacement down with it.
    expect(isTrackPlaying("pad-1")).toBe(true);
  });
});
