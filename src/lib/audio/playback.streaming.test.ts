// @vitest-environment jsdom
/**
 * The streaming path: a blob played through an `<audio>` element rather than
 * decoded into an AudioBuffer, so a long file costs no PCM memory.
 *
 * Everything hard about it comes from one fact: a media element does not know
 * how long the file is, or where it can seek to, until metadata loads. So the
 * trim range is applied twice — optimistically at trigger time, and again on
 * `loadedmetadata` against the real duration — and the track is registered
 * with a duration of zero that the monitoring loop fills in later. Each of
 * those is a place a trimmed cue can silently play from the top, or show no
 * progress bar for its whole length.
 *
 * The object URL is the other thing worth pinning. It is revoked when the
 * track is disposed, and — the case that leaks — when the element never
 * becomes a track at all because something threw on the way. Nothing else
 * holds a reference to revoke it later, so the blob stays in memory for the
 * life of the tab.
 *
 * `waitForStreamingPlayable` is the caller's fallback signal: a media pipeline
 * that cannot handle a file has to be distinguishable from one that is merely
 * slow, or the pad falls back to a full decode it did not need — or worse,
 * never falls back and stays silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { PlayAudioParams } from "@/lib/audio/types";

class RecordingGain {
  value = 1;
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
}

const context = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createBufferSource: () => ({
    connect() {},
    disconnect() {},
    start() {},
    stop() {},
    onended: null,
  }),
  createGain: () => ({
    gain: new RecordingGain(),
    connect() {},
    disconnect() {},
  }),
  createMediaElementSource: vi.fn(() => ({ connect() {}, disconnect() {} })),
};

vi.mock("./context", () => ({ getAudioContext: () => context }));
vi.mock("@/store/playbackStore", () => ({
  playbackStoreActions: {
    setPlaybackState: () => {},
    addTrack: () => {},
    removeTrack: () => {},
    clearAllTracks: () => {},
    setTrackFading: () => {},
  },
}));

/** Object URLs handed out, and the ones handed back. */
const created: string[] = [];
const revoked: string[] = [];
let nextUrl = 0;

/** The rAF callback waiting to run, so the loop can be stepped by hand. */
let pendingFrame: FrameRequestCallback | null = null;

const playback = await import("./playback");

/** Runs one frame of the monitoring loop, if one is scheduled. */
function tick(): void {
  const frame = pendingFrame;
  pendingFrame = null;
  frame?.(0);
}

function params(name: string, trim: Partial<PlayAudioParams> = {}) {
  return {
    name,
    volume: 1,
    ...trim,
    multiSoundState: {
      playbackType: "sequential",
      allAudioFileIds: [1],
      currentAudioFileId: 1,
      currentAudioIndex: 0,
    },
  } as unknown as PlayAudioParams;
}

/** The `<audio>` element of the track under `key`. */
function elementOf(key: string): HTMLAudioElement {
  const source = playback.getActiveTrack(key)?.source as unknown as {
    element: HTMLAudioElement;
  };
  return source.element;
}

/**
 * Gives an element a duration it would otherwise never have.
 *
 * jsdom loads no media, so `duration` is `NaN` for the whole life of the
 * element — which is exactly the state the code is written for, but it means
 * a test that wants the *post*-metadata behaviour has to supply it.
 */
function withDuration(element: HTMLAudioElement, duration: number): void {
  Object.defineProperty(element, "duration", {
    configurable: true,
    get: () => duration,
  });
}

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  pendingFrame = null;
  context.currentTime = 0;
  context.createMediaElementSource.mockClear();

  URL.createObjectURL = vi.fn(() => {
    const url = `blob:fake-${nextUrl++}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));

  // jsdom's own play() rejects with "Not implemented"; the streaming path
  // treats a rejected play() as a failure and tears the track down, which
  // would make every test here about that one path.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
    (callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    },
  );
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
    pendingFrame = null;
  });
  quietConsole();
});

afterEach(() => {
  // A media element's disposal is deferred past the anti-click ramp, so
  // stopping a leftover track only *schedules* its revoke. Left on real
  // timers, those fire in the middle of a later test and are attributed to
  // it — which is a genuinely confusing failure to read. Drain them here.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  playback.stopAllTracks();
  vi.advanceTimersByTime(1000);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("playBlobStreaming", () => {
  it("registers a track routed through the Web Audio graph", () => {
    const element = playback.playBlobStreaming(
      new Blob(["audio"]),
      "pad-1",
      params("pad-1"),
    );

    expect(element).not.toBeNull();
    expect(playback.isTrackPlaying("pad-1")).toBe(true);
    // The graph is what makes fades and stop-all work on a streamed track.
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("points the element at an object URL for the blob", () => {
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));

    expect(created).toHaveLength(1);
    expect(elementOf("pad-1").src).toContain(created[0]);
  });

  it("revokes that URL once the de-click ramp has run", () => {
    // Nothing else holds a reference, so a missed revoke keeps the blob in
    // memory for the life of the tab. A media element cannot schedule its own
    // pause, so the release waits out the short anti-click ramp on a timer —
    // which means the revoke is not synchronous with the stop.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));

    playback.stopTrack("pad-1");
    expect(playback.isTrackPlaying("pad-1")).toBe(false);
    expect(revoked).toEqual([]);

    vi.advanceTimersByTime(1000);

    expect(revoked).toEqual(created);
  });

  it("revokes the URL when the track never starts at all", () => {
    context.createMediaElementSource.mockImplementationOnce(() => {
      throw new Error("MediaElementSource already exists for this element");
    });

    expect(
      playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1")),
    ).toBeNull();
    expect(revoked).toEqual(created);
    expect(playback.isTrackPlaying("pad-1")).toBe(false);
  });

  it("registers a duration of zero while the length is still unknown", () => {
    // jsdom never loads the media, which is precisely the pre-metadata state.
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));

    expect(playback.getActiveTrack("pad-1")?.duration).toBe(0);
  });

  it("takes the trimmed length from the trim range alone when it can", () => {
    // A trim end is a number the caller already knows; it does not need the
    // file's duration to say how long the cue runs.
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimStart: 2, trimEnd: 7 }),
    );

    expect(playback.getActiveTrack("pad-1")?.duration).toBe(5);
  });

  it("seeks to the trim start immediately, before metadata has landed", () => {
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimStart: 3 }),
    );

    expect(elementOf("pad-1").currentTime).toBe(3);
  });

  it("survives an element that refuses the early seek", () => {
    // Some browsers throw on a seek before metadata; the handler below retries.
    const seek = vi
      .spyOn(HTMLMediaElement.prototype, "currentTime", "set")
      .mockImplementation(() => {
        throw new Error("InvalidStateError");
      });

    expect(
      playback.playBlobStreaming(
        new Blob(["a"]),
        "pad-1",
        params("pad-1", { trimStart: 3 }),
      ),
    ).not.toBeNull();
    expect(seek).toHaveBeenCalled();
  });

  it("tears the track down when play() is refused", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("NotAllowedError"),
    );

    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));
    await vi.waitFor(() =>
      expect(playback.isTrackPlaying("pad-1")).toBe(false),
    );

    expect(revoked).toEqual(created);
  });

  it("tears the track down when the element reports an error", () => {
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));

    elementOf("pad-1").dispatchEvent(new Event("error"));

    expect(playback.isTrackPlaying("pad-1")).toBe(false);
  });

  it("clears the track when it plays to its end", () => {
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));

    elementOf("pad-1").dispatchEvent(new Event("ended"));

    expect(playback.isTrackPlaying("pad-1")).toBe(false);
  });

  it("leaves a successor alone when a replaced element ends late", () => {
    // "restart" behaviour replaces the track; the old element's `ended` must
    // not remove the new one's state.
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));
    const stale = elementOf("pad-1");
    playback.playBlobStreaming(new Blob(["b"]), "pad-1", params("pad-1"));

    stale.dispatchEvent(new Event("ended"));

    expect(playback.isTrackPlaying("pad-1")).toBe(true);
  });
});

describe("once metadata arrives", () => {
  it("fills in a duration that could not be known at trigger time", () => {
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));
    const element = elementOf("pad-1");
    withDuration(element, 42);

    element.dispatchEvent(new Event("loadedmetadata"));

    expect(playback.getActiveTrack("pad-1")?.duration).toBe(42);
  });

  it("drops a trim end past the real end of the file", () => {
    // The caller's trim range was checked against nothing at trigger time. An
    // unusable end point becomes "no end point" — play to the natural end —
    // rather than being clamped to the duration, so a cue built against a
    // longer file does not acquire an arbitrary cut.
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimStart: 1, trimEnd: 500 }),
    );
    const element = elementOf("pad-1");
    withDuration(element, 10);

    element.dispatchEvent(new Event("loadedmetadata"));

    const track = playback.getActiveTrack("pad-1");
    expect(track?.trimEnd).toBeUndefined();
    // And the duration goes with it. The handler used to fill in only a
    // duration that was still zero, so this reported 499 — the length implied
    // by a trim end the file does not have — for its whole nine seconds of
    // playback. Reachable rather than theoretical: `audioTrimSettings` is
    // keyed by audio file id and survives `replaceMissingAudioFile`, so
    // replacing a missing sound with a shorter one produces exactly this.
    expect(track?.duration).toBe(9);
  });

  it("retries the start seek the element refused earlier", () => {
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimStart: 4 }),
    );
    const element = elementOf("pad-1");
    element.currentTime = 0; // as an element that ignored the early seek would
    withDuration(element, 30);

    element.dispatchEvent(new Event("loadedmetadata"));

    expect(element.currentTime).toBe(4);
  });

  it("ignores metadata that says nothing about the duration", () => {
    // A live stream reports Infinity; there is nothing to re-clamp against.
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));
    const element = elementOf("pad-1");
    withDuration(element, Infinity);

    element.dispatchEvent(new Event("loadedmetadata"));

    expect(playback.getActiveTrack("pad-1")?.duration).toBe(0);
  });
});

describe("the monitoring loop on a streamed track", () => {
  it("adopts the element's duration on the first frame that can see it", () => {
    // The `loadedmetadata` listener is `once`, so a track whose metadata
    // landed before the listener attached would otherwise stay at zero.
    playback.playBlobStreaming(new Blob(["a"]), "pad-1", params("pad-1"));
    withDuration(elementOf("pad-1"), 20);

    tick();

    expect(playback.getActiveTrack("pad-1")?.duration).toBe(20);
  });

  it("cuts a trimmed track that has run past its end", () => {
    // The backstop for `scheduleStreamingTrimEnd`, for an element reporting a
    // position ahead of where it was seeked.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimEnd: 5 }),
    );
    const element = elementOf("pad-1");
    element.currentTime = 6;

    tick();

    expect(playback.isTrackPlaying("pad-1")).toBe(false);
    expect(revoked).toEqual(created);
  });

  it("leaves a fading track to its fade rather than cutting it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    playback.playBlobStreaming(
      new Blob(["a"]),
      "pad-1",
      params("pad-1", { trimEnd: 5 }),
    );
    playback.fadeOutInstance("pad-1", 3);
    elementOf("pad-1").currentTime = 6;

    tick();

    expect(playback.isTrackPlaying("pad-1")).toBe(true);
  });
});

describe("waitForStreamingPlayable", () => {
  /** An element stub with just the readiness surface the helper reads. */
  function fakeElement(overrides: Partial<HTMLAudioElement> = {}) {
    const element = new Audio();
    Object.defineProperty(element, "readyState", {
      configurable: true,
      get: () => overrides.readyState ?? 0,
    });
    Object.defineProperty(element, "error", {
      configurable: true,
      get: () => overrides.error ?? null,
    });
    return element;
  }

  it("says no for an element that failed, however much it buffered", async () => {
    // The error check has to come *first*: an element that decoded a header
    // and then hit an unsupported codec reports both a healthy `readyState`
    // and an `error`, and answering from the readyState alone says yes to a
    // file that will never play.
    const element = fakeElement({
      error: { code: 4 } as MediaError,
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
    });

    await expect(playback.waitForStreamingPlayable(element)).resolves.toBe(
      false,
    );
  });

  it("says yes straight away for an element that is already buffered", async () => {
    const element = fakeElement({
      readyState: HTMLMediaElement.HAVE_FUTURE_DATA,
    });

    await expect(playback.waitForStreamingPlayable(element)).resolves.toBe(
      true,
    );
  });

  it.each(["canplay", "playing"])(
    "says yes when the element fires %s",
    async (event) => {
      const element = fakeElement();
      const answer = playback.waitForStreamingPlayable(element);

      element.dispatchEvent(new Event(event));

      await expect(answer).resolves.toBe(true);
    },
  );

  it.each(["error", "emptied", "abort"])(
    "says no when the element fires %s",
    async (event) => {
      // `emptied` and `abort` are the disposal cases: a rejected play() tears
      // the element down, and a caller still waiting must not wait forever.
      const element = fakeElement();
      const answer = playback.waitForStreamingPlayable(element);

      element.dispatchEvent(new Event(event));

      await expect(answer).resolves.toBe(false);
    },
  );

  it("gives up after the safety net, answering from the readyState", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const element = fakeElement();
    const answer = playback.waitForStreamingPlayable(element);

    await vi.advanceTimersByTimeAsync(4000);

    await expect(answer).resolves.toBe(false);
  });

  it("stops listening once it has answered", async () => {
    const element = fakeElement();
    const remove = vi.spyOn(element, "removeEventListener");

    element.dispatchEvent(new Event("canplay"));
    const answer = playback.waitForStreamingPlayable(element);
    element.dispatchEvent(new Event("canplay"));
    await answer;

    expect(remove).toHaveBeenCalledWith("canplay", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
