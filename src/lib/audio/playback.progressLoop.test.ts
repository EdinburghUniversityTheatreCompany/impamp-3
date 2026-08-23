/**
 * The rAF loop that keeps the Active Tracks panel honest, and the fades that
 * end a track gently.
 *
 * The loop is the one part of the playback engine no other suite drives:
 * `playback.layers`, `playback.race` and `playback.trimEnd` all stub
 * `requestAnimationFrame` to a no-op, deliberately, because a running loop
 * would be noise in a test about which source got stopped. Here the stub is a
 * queue a test steps by hand, which is what makes the loop's own decisions
 * observable.
 *
 * Three of those decisions matter:
 *
 * **It publishes only when something changed.** Progress moves by a fraction
 * of a percent per frame, and pushing a new Map into Zustand sixty times a
 * second re-renders the panel sixty times a second for a countdown that reads
 * the same. The thresholds are what stop that — but the comparison baseline is
 * only advanced for state that was actually published, or small per-frame
 * deltas would be discarded one at a time and the display would freeze.
 *
 * **It stops itself.** The loop reschedules from inside its own tick, so a
 * loop that never notices `activeTracks` emptying is a permanent 60 Hz wake-up
 * in a backgrounded tab.
 *
 * **A streamed track gets its duration late.** A media element does not know
 * how long the file is until metadata loads, so the track is registered with
 * duration 0 and the loop fills it in on the first frame that can see it. A
 * track left at 0 shows no progress bar at all.
 *
 * The fade cleanup is here for a related reason: it runs on a timer, and what
 * it must do depends on whether the key still holds the track it started
 * fading. Both halves stop the source; only one of them clears the state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { PlayAudioParams } from "@/lib/audio/types";

/** Automation the tests can read back, unlike the shared fake's. */
class RecordingParam {
  value = 1;
  ramps: Array<[number, number]> = [];
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  linearRampToValueAtTime(value: number, when: number) {
    this.ramps.push([value, when]);
    return this;
  }
}

class RecordingSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  stopCalls = 0;
  connect() {}
  disconnect() {}
  start() {}
  stop() {
    this.stopCalls++;
  }
}

const context = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createBufferSource: () => new RecordingSource(),
  createGain: () => ({
    gain: new RecordingParam(),
    connect() {},
    disconnect() {},
  }),
};

vi.mock("./context", () => ({ getAudioContext: () => context }));

/** Every playback state the engine has published, newest last. */
const published: Array<Map<string, { progress: number; isFading: boolean }>> =
  [];
vi.mock("@/store/playbackStore", () => ({
  playbackStoreActions: {
    setPlaybackState: (state: Map<string, never>) =>
      void published.push(new Map(state)),
    addTrack: () => {},
    removeTrack: () => {},
    clearAllTracks: () => {},
    setTrackFading: () => {},
  },
}));

// `startPlaybackLoop` refuses to schedule anything without a `window`, which
// is the server-side guard — and in the node environment that means the loop
// never starts at all. This is the whole of the DOM it needs.
globalThis.window = globalThis as unknown as Window & typeof globalThis;

/** The rAF callback waiting to run, if the loop scheduled one. */
let pendingFrame: FrameRequestCallback | null = null;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  pendingFrame = callback;
  return 1;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {
  pendingFrame = null;
}) as typeof cancelAnimationFrame;

const playback = await import("./playback");

/**
 * Fake timers for the fade's `setTimeout` only.
 *
 * A bare `vi.useFakeTimers()` also fakes `requestAnimationFrame`, which takes
 * the loop out of this suite's hands entirely — the stub above stops being
 * called, `tick()` does nothing, and a test about what the loop published
 * passes or fails for reasons that have nothing to do with the loop.
 */
function useFadeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** Runs one frame of the loop, if one is scheduled. */
function tick(): void {
  const frame = pendingFrame;
  pendingFrame = null;
  frame?.(0);
}

/** A buffer of `duration` seconds. Only `duration` is ever read. */
const bufferOf = (duration: number) =>
  ({ duration, numberOfChannels: 2 }) as unknown as AudioBuffer;

function params(name: string): PlayAudioParams {
  return {
    name,
    volume: 1,
    multiSoundState: {
      playbackType: "sequential",
      allAudioFileIds: [1],
      currentAudioFileId: 1,
      currentAudioIndex: 0,
    },
  } as unknown as PlayAudioParams;
}

/** The last published entry for one key. */
const lastFor = (key: string) => published[published.length - 1]?.get(key);

beforeEach(() => {
  playback.stopAllTracks();
  published.length = 0;
  pendingFrame = null;
  context.currentTime = 0;
  quietConsole();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the monitoring loop", () => {
  it("starts as soon as a track does", () => {
    expect(pendingFrame).toBeNull();

    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));

    expect(pendingFrame).not.toBeNull();
  });

  it("publishes progress and remaining time as the context advances", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));

    context.currentTime = 2.5;
    tick();

    expect(lastFor("pad-1")).toMatchObject({
      progress: 0.25,
      remainingTime: 7.5,
      totalDuration: 10,
      name: "pad-1",
    });
  });

  it("keeps rescheduling itself while anything is playing", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));

    context.currentTime = 1;
    tick();

    expect(pendingFrame).not.toBeNull();
  });

  it("has no frame outstanding once the last track has gone", () => {
    // A loop that keeps running is a 60 Hz wake-up in a backgrounded tab.
    // Note where the cancellation actually happens: every removal path goes
    // through `clearTrackState`, which calls `stopPlaybackLoopIfIdle` itself,
    // so the frame is already cancelled before the next tick could notice.
    // The loop's own two idle checks are a backstop for the one path that
    // removes a track from inside a tick — the streaming trim-end, covered in
    // `playback.streaming.test.ts`.
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    context.currentTime = 1;
    tick();

    playback.stopTrack("pad-1");
    tick();

    expect(pendingFrame).toBeNull();
  });

  it("does not republish a frame nothing moved in", () => {
    playback.playBuffer(bufferOf(100), "pad-1", params("pad-1"));
    context.currentTime = 1;
    tick();
    const after = published.length;

    // A hundredth of a second on a hundred-second track: under both
    // thresholds, so the panel would render an identical countdown.
    context.currentTime = 1.001;
    tick();

    expect(published).toHaveLength(after);
  });

  it("publishes once the small deltas have added up", () => {
    // The baseline only advances for state that was published, so a run of
    // sub-threshold frames accumulates rather than being discarded one by one.
    playback.playBuffer(bufferOf(100), "pad-1", params("pad-1"));
    context.currentTime = 1;
    tick();
    const after = published.length;

    for (let i = 1; i <= 20; i++) {
      context.currentTime = 1 + i * 0.001;
      tick();
    }

    expect(published.length).toBeGreaterThan(after);
  });

  it("publishes a fade the moment it starts, whatever the progress did", () => {
    useFadeTimers();
    playback.playBuffer(bufferOf(100), "pad-1", params("pad-1"));
    context.currentTime = 1;
    tick();

    playback.fadeOutInstance("pad-1", 3);
    tick();

    expect(lastFor("pad-1")?.isFading).toBe(true);
  });

  it("drops a track whose time is up rather than reporting it at zero", () => {
    // `onended` owns the real cleanup; this only keeps a finished track out of
    // the panel in the frames before it fires.
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    playback.playBuffer(bufferOf(60), "pad-2", params("pad-2"));
    context.currentTime = 11;
    tick();

    expect(lastFor("pad-1")).toBeUndefined();
    expect(lastFor("pad-2")).toBeDefined();
  });

  it("reports a track of unknown length as making no progress", () => {
    // A streamed file before its metadata arrives. Progress of NaN would
    // render as an empty bar; 0 renders as a bar that has not moved.
    playback.playBuffer(bufferOf(0), "pad-1", params("pad-1"));

    context.currentTime = 5;
    tick();

    expect(lastFor("pad-1")).toMatchObject({
      progress: 0,
      remainingTime: 0,
      totalDuration: 0,
    });
  });
});

describe("fading", () => {
  beforeEach(useFadeTimers);

  it("ramps to silence over the requested duration", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    context.currentTime = 2;

    expect(playback.fadeOutInstance("pad-1", 3)).toBe(true);

    const track = playback.getActiveTrack("pad-1");
    const gain = track?.gainNode.gain as unknown as RecordingParam;
    expect(gain.ramps).toEqual([[0, 5]]);
    expect(playback.isTrackFading("pad-1")).toBe(true);
  });

  it("stops the source and clears the key once the fade finishes", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    const source = playback.getActiveTrack("pad-1")?.source as unknown as {
      sourceNode: RecordingSource;
    };
    playback.fadeOutInstance("pad-1", 2);

    vi.advanceTimersByTime(2000);

    expect(playback.isTrackPlaying("pad-1")).toBe(false);
    expect(source.sourceNode.stopCalls).toBeGreaterThan(0);
  });

  it("silences a faded source even when the key has been taken over", () => {
    // The fading source no longer owns the key, and nothing else would ever
    // stop it — it would keep playing, inaudibly ramped to zero, for its
    // whole length.
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    const fading = playback.getActiveTrack("pad-1")?.source as unknown as {
      sourceNode: RecordingSource;
    };
    playback.fadeOutInstance("pad-1", 2);
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    const replacement = playback.getActiveTrack("pad-1");

    vi.advanceTimersByTime(2000);

    expect(fading.sourceNode.stopCalls).toBeGreaterThan(0);
    expect(playback.getActiveTrack("pad-1")).toBe(replacement);
  });

  it("refuses to fade a key that is not playing", () => {
    expect(playback.fadeOutInstance("pad-nothing", 3)).toBe(false);
  });

  it("does not restart a fade already running", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    playback.fadeOutInstance("pad-1", 3);
    const gain = playback.getActiveTrack("pad-1")?.gainNode
      .gain as unknown as RecordingParam;
    const rampsSoFar = gain.ramps.length;

    playback.fadeOutAllTracks(3);

    expect(gain.ramps).toHaveLength(rampsSoFar);
  });
});

describe("fadeOutAllTracks", () => {
  beforeEach(useFadeTimers);

  it("counts what it actually started fading", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    playback.playBuffer(bufferOf(10), "pad-2", params("pad-2"));

    expect(playback.fadeOutAllTracks(2)).toBe(2);
    expect(playback.isTrackFading("pad-1")).toBe(true);
    expect(playback.isTrackFading("pad-2")).toBe(true);
  });

  it("skips a pad already fading, so its ramp is not restarted", () => {
    // Fade Out All pressed twice must not extend the first fade. The count is
    // what this can see; note that `fadeOutInstance` refuses an already-fading
    // track too, so the loop's own `isFading` check is a second copy of the
    // same rule (recorded in plans/off-topic-improvements.md).
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    playback.playBuffer(bufferOf(10), "pad-2", params("pad-2"));
    playback.fadeOutInstance("pad-1", 2);

    expect(playback.fadeOutAllTracks(2)).toBe(1);
  });

  it("counts nothing when nothing is playing", () => {
    expect(playback.fadeOutAllTracks(2)).toBe(0);
  });

  it("clears every key once the fades finish", () => {
    playback.playBuffer(bufferOf(10), "pad-1", params("pad-1"));
    playback.playBuffer(bufferOf(10), "pad-2", params("pad-2"));
    playback.fadeOutAllTracks(1);

    vi.advanceTimersByTime(1000);

    expect(playback.isTrackPlaying("pad-1")).toBe(false);
    expect(playback.isTrackPlaying("pad-2")).toBe(false);
  });
});
