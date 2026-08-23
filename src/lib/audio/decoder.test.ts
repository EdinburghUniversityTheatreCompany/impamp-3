/**
 * The single-file decode paths, and the in-flight sharing that sits under all
 * three of them.
 *
 * `decoder.pipeline.test.ts` covers the batch preloader's slot accounting.
 * This is the other half: one file at a time, where the invariants are about
 * *not* doing work twice and about remembering failures.
 *
 * Two of them are easy to break and expensive when broken:
 *
 * **A failure is cached.** A blob that will not decode is a permanent fact
 * about that row, so the null is written to the cache and every later trigger
 * of that pad returns instantly instead of re-reading a megabyte from
 * IndexedDB and re-failing. A version that only cached successes would turn a
 * corrupt sound into a per-press disk read during a show.
 *
 * **One decode is shared.** The preloader and a keypress race for the same
 * file by design, and decoding is the expensive part. The in-flight entry is
 * what makes the second caller wait on the first's decode rather than starting
 * its own — and it must be removed afterwards, or a re-decode after a cache
 * eviction would join a promise that settled long ago.
 *
 * The loading-state callback is the third thing here, and it is not
 * decoration: it drives the pad's spinner. A path that forgets its terminal
 * `ready`/`error` leaves a pad spinning forever with the sound already
 * playing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { LoadingState } from "./decoder";

/** What `getAudioFile` will answer with, per id. Empty means "not found". */
const rows = new Map<number, { id: number; name: string; blob: Blob }>();
const getAudioFile = vi.fn(async (id: number) => rows.get(id));

/** The decode outcome per blob size, so a test can make one file fail. */
const undecodable = new Set<number>();
const decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
  if (undecodable.has(bytes.byteLength)) {
    throw new Error("EncodingError: unsupported");
  }
  return { duration: bytes.byteLength } as unknown as AudioBuffer;
});

/** A real Map, so "the failure was cached" is observable rather than asserted
 * against a spy that would also pass if the value written were wrong. */
const cache = new Map<number, AudioBuffer | null>();

vi.mock("../db", () => ({
  getAudioFile: (id: number) => getAudioFile(id),
}));

vi.mock("./cache", () => ({
  isAudioBufferCached: (id: number) => cache.has(id),
  getCachedAudioBuffer: (id: number) => cache.get(id),
  cacheAudioBuffer: (id: number, buffer: AudioBuffer | null) =>
    void cache.set(id, buffer),
}));

vi.mock("./context", () => ({
  getAudioContext: () => ({ decodeAudioData }),
}));

const decoder = await import("./decoder");

/**
 * Registers a row whose blob decodes to a buffer of `size` "seconds".
 *
 * The size doubles as the decoded buffer's duration, which is what lets a test
 * tell one file's buffer from another's without a fixture.
 *
 * @param id - The audio file id
 * @param size - Byte length of the blob, and duration of what it decodes to
 */
function givenRow(id: number, size = 8): void {
  rows.set(id, {
    id,
    name: `file-${id}.wav`,
    blob: {
      size,
      arrayBuffer: async () => new ArrayBuffer(size),
    } as unknown as Blob,
  });
}

/** Collects loading states in order, for assertions on the spinner's script. */
function stateRecorder() {
  const states: LoadingState[] = [];
  const callback = (state: LoadingState) => void states.push(state);
  return {
    callback,
    /** The status/progress pairs, which is all any assertion here needs. */
    get script() {
      return states.map((s) => [s.status, s.progress] as const);
    },
    get last() {
      return states[states.length - 1];
    },
  };
}

beforeEach(() => {
  rows.clear();
  cache.clear();
  undecodable.clear();
  getAudioFile.mockClear();
  decodeAudioData.mockClear();
  quietConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decodeAudioBlob", () => {
  it("hands the blob's bytes to the audio context", async () => {
    const blob = {
      size: 16,
      arrayBuffer: async () => new ArrayBuffer(16),
    } as unknown as Blob;

    const buffer = await decoder.decodeAudioBlob(blob);

    expect(buffer.duration).toBe(16);
  });

  it("replaces the codec's own message with one the app controls", async () => {
    // The browser's EncodingError text is not something the UI can show, and
    // the original is logged rather than thrown.
    undecodable.add(4);
    const blob = {
      size: 4,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Blob;

    await expect(decoder.decodeAudioBlob(blob)).rejects.toThrow(
      "Failed to decode audio data.",
    );
    expect(console.error).toHaveBeenCalled();
  });
});

describe("loadAndDecodeAudio", () => {
  it("reads and decodes a file that is not cached yet", async () => {
    givenRow(1, 12);

    const buffer = await decoder.loadAndDecodeAudio(1);

    expect(buffer?.duration).toBe(12);
    expect(cache.get(1)).toBe(buffer);
  });

  it("returns a cached buffer without touching the database", async () => {
    cache.set(2, { duration: 99 } as unknown as AudioBuffer);

    expect((await decoder.loadAndDecodeAudio(2))?.duration).toBe(99);
    expect(getAudioFile).not.toHaveBeenCalled();
  });

  it("remembers a failure, so a broken sound is not re-read per press", async () => {
    cache.set(3, null);

    expect(await decoder.loadAndDecodeAudio(3)).toBeNull();
    expect(getAudioFile).not.toHaveBeenCalled();
  });

  it("caches the miss when the row has no blob", async () => {
    rows.set(4, { id: 4, name: "gone" } as never);

    expect(await decoder.loadAndDecodeAudio(4)).toBeNull();
    expect(cache.get(4)).toBeNull();
  });

  it("caches the miss when the row is absent altogether", async () => {
    expect(await decoder.loadAndDecodeAudio(5)).toBeNull();
    expect(cache.get(5)).toBeNull();
  });

  it("caches the failure when the bytes will not decode", async () => {
    givenRow(6, 4);
    undecodable.add(4);

    expect(await decoder.loadAndDecodeAudio(6)).toBeNull();
    expect(cache.get(6)).toBeNull();
  });

  it("shares one decode between a preload and a keypress", async () => {
    givenRow(7, 20);

    const [first, second] = await Promise.all([
      decoder.loadAndDecodeAudio(7),
      decoder.loadAndDecodeAudio(7),
    ]);

    expect(first).toBe(second);
    expect(getAudioFile).toHaveBeenCalledTimes(1);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it("releases the in-flight entry once the load settles", async () => {
    // Otherwise a later caller, after the buffer had been evicted, would join
    // a promise that settled long ago and get a buffer the cache no longer has.
    givenRow(8, 8);
    await decoder.loadAndDecodeAudio(8);
    cache.clear();

    await decoder.loadAndDecodeAudio(8);

    expect(getAudioFile).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight entry even when the load fails", async () => {
    givenRow(9, 4);
    undecodable.add(4);
    await decoder.loadAndDecodeAudio(9);
    cache.clear();

    await decoder.loadAndDecodeAudio(9);

    expect(getAudioFile).toHaveBeenCalledTimes(2);
  });
});

describe("loadAndDecodeAudioEnhanced", () => {
  it("scripts the spinner from loading through decoding to ready", async () => {
    givenRow(10, 8);
    const recorder = stateRecorder();

    await decoder.loadAndDecodeAudioEnhanced(10, recorder.callback);

    expect(recorder.script).toEqual([
      ["loading", 0],
      ["loading", 0.1],
      ["decoding", 0.3],
      ["ready", 1],
    ]);
  });

  it("ends on ready for a cache hit, without a decoding step", async () => {
    cache.set(11, { duration: 3 } as unknown as AudioBuffer);
    const recorder = stateRecorder();

    await decoder.loadAndDecodeAudioEnhanced(11, recorder.callback);

    expect(recorder.script).toEqual([
      ["loading", 0],
      ["ready", 1],
    ]);
  });

  it("reports a remembered failure as an error, not as a silent null", async () => {
    // The pad has to stop spinning either way; only the message differs.
    cache.set(12, null);
    const recorder = stateRecorder();

    expect(
      await decoder.loadAndDecodeAudioEnhanced(12, recorder.callback),
    ).toBeNull();
    expect(recorder.last).toMatchObject({
      status: "error",
      error: "Previously failed to decode",
    });
  });

  it("surfaces a decode failure's message to the spinner", async () => {
    givenRow(13, 4);
    undecodable.add(4);
    const recorder = stateRecorder();

    await decoder.loadAndDecodeAudioEnhanced(13, recorder.callback);

    expect(recorder.last).toMatchObject({
      status: "error",
      error: "Failed to decode audio data.",
    });
  });

  it("reports a missing row without pretending to decode", async () => {
    const recorder = stateRecorder();

    await decoder.loadAndDecodeAudioEnhanced(14, recorder.callback);

    expect(recorder.last).toMatchObject({
      status: "error",
      error: "Audio file not found or has no data",
    });
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it("reports a non-Error rejection rather than losing the state entirely", async () => {
    givenRow(15, 8);
    decodeAudioData.mockRejectedValueOnce("a string, not an Error");
    const recorder = stateRecorder();

    await decoder.loadAndDecodeAudioEnhanced(15, recorder.callback);

    expect(recorder.last?.status).toBe("error");
  });

  it("works with no callback at all", async () => {
    givenRow(16, 8);

    await expect(decoder.loadAndDecodeAudioEnhanced(16)).resolves.toMatchObject(
      { duration: 8 },
    );
  });

  it("reports ready to a joiner of someone else's decode", async () => {
    givenRow(17, 8);
    const recorder = stateRecorder();

    const first = decoder.loadAndDecodeAudio(17);
    const joined = decoder.loadAndDecodeAudioEnhanced(17, recorder.callback);

    expect(await joined).toBe(await first);
    expect(recorder.last).toMatchObject({ status: "ready", progress: 1 });
  });

  it("reports error to a joiner whose shared decode failed", async () => {
    givenRow(18, 4);
    undecodable.add(4);
    const recorder = stateRecorder();

    const first = decoder.loadAndDecodeAudio(18);
    await decoder.loadAndDecodeAudioEnhanced(18, recorder.callback);
    await first;

    expect(recorder.last).toMatchObject({
      status: "error",
      error: "Failed to load audio",
    });
  });
});

describe("loadAndDecodeAudioInstant", () => {
  it("takes the cache-hit shortcut through the enhanced path", async () => {
    cache.set(19, { duration: 5 } as unknown as AudioBuffer);
    const recorder = stateRecorder();

    expect(
      (await decoder.loadAndDecodeAudioInstant(19, recorder.callback))
        ?.duration,
    ).toBe(5);
    // Two "loading" openers: its own, then the enhanced call's.
    expect(recorder.script).toEqual([
      ["loading", 0],
      ["loading", 0],
      ["ready", 1],
    ]);
  });

  it("loads and decodes on a cache miss", async () => {
    givenRow(20, 7);
    const recorder = stateRecorder();

    expect(
      (await decoder.loadAndDecodeAudioInstant(20, recorder.callback))
        ?.duration,
    ).toBe(7);
    expect(recorder.last).toMatchObject({ status: "ready", progress: 1 });
  });

  it("joins a decode already running for the same file", async () => {
    givenRow(21, 8);
    const recorder = stateRecorder();

    const first = decoder.loadAndDecodeAudio(21);
    const joined = decoder.loadAndDecodeAudioInstant(21, recorder.callback);

    expect(await joined).toBe(await first);
    expect(getAudioFile).toHaveBeenCalledTimes(1);
    expect(recorder.last).toMatchObject({ status: "ready" });
  });
});
