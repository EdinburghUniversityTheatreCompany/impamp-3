/**
 * The preload queue: what it decides to load, in what order, and what it does
 * when a load fails.
 *
 * The preloader's whole job is deciding *what*, so the loading itself is
 * stubbed — the decoder's own suites cover that. What is left is scheduling,
 * and it has three properties worth holding:
 *
 * **Priority is re-read between chunks, not once at the start.** A page switch
 * queues IMMEDIATE work while a background sweep of the whole profile is still
 * running, and the operator is about to press something on the page they just
 * opened. If the queue were drained in arrival order, that press waits behind
 * every sound in the profile.
 *
 * **A failure is retried by priority and then remembered.** IMMEDIATE work
 * gets three more attempts on a rising backoff; background work gets one.
 * Once the attempts are spent the null is cached, which is what stops a
 * genuinely broken row from being re-read forever.
 *
 * **Already-cached files never reach a batch.** They are filtered when queued
 * *and* again when the chunk is taken, because a file can be decoded by a
 * keypress in between — the two checks are not redundant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration } from "../db";

// The decoder pulls in the Web Audio API, which Vitest's node environment has
// no business providing — the preloader's job is deciding *what* to load, so
// the loading itself is stubbed.
const pipelinedLoad = vi.fn();
vi.mock("./decoder", () => ({
  loadAndDecodeAudioPipelined: (...args: unknown[]) => pipelinedLoad(...args),
}));

const { audioPreloader } = await import("./preloader");
const {
  cacheAudioBuffer,
  clearAudioCache,
  getCachedAudioBuffer,
  isAudioBufferCached,
} = await import("./cache");

function fakeBuffer(): AudioBuffer {
  return {
    numberOfChannels: 2,
    sampleRate: 48000,
    duration: 1,
    length: 48000,
  } as unknown as AudioBuffer;
}

/** A pad config carrying only what the preloader reads off it. */
function padWith(audioFileIds: number[]): PadConfiguration {
  return { audioFileIds } as unknown as PadConfiguration;
}

/** The id lists handed to the decoder, one entry per batch, in order. */
const batchedIds = (): number[][] =>
  pipelinedLoad.mock.calls.map((call) => call[0] as number[]);

/** Makes every load in this test fail, as a decode of a corrupt blob would. */
function everythingFails(): void {
  pipelinedLoad.mockImplementation(
    async (audioFileIds: number[]) =>
      new Map(audioFileIds.map((id) => [id, null])),
  );
}

/**
 * Holds the next load open until the returned function is called.
 *
 * Every ordering test here needs a batch that is demonstrably still in flight
 * while more work is queued behind it; releasing on demand is what makes that
 * deterministic rather than a race against the microtask queue.
 *
 * @returns A function that completes the held batch successfully
 */
function holdNextLoad(): () => void {
  let release: () => void = () => {};
  pipelinedLoad.mockImplementationOnce(
    async (ids: number[]) =>
      new Promise((resolve) => {
        release = () => resolve(new Map(ids.map((id) => [id, fakeBuffer()])));
      }),
  );
  return () => release();
}

/** Resets the singleton between tests; it outlives any one of them. */
function resetPreloader(): void {
  clearAudioCache();
  audioPreloader.clearQueue();
  audioPreloader.resumePreloading();
  pipelinedLoad.mockReset();
  pipelinedLoad.mockImplementation(
    async (audioFileIds: number[]) =>
      new Map(audioFileIds.map((id) => [id, fakeBuffer()])),
  );
}

beforeEach(resetPreloader);

afterEach(() => {
  vi.useRealTimers();
});

describe("preloading an armed track", () => {
  it("decodes every sound of the armed pad into the cache", async () => {
    audioPreloader.preloadArmedTrack([11, 12], {
      profileId: 1,
      bankId: "2",
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
      bankId: "2",
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
      bankId: "2",
      padIndex: 3,
    });
    await vi.waitFor(() => expect(isAudioBufferCached(31)).toBe(true));
    pipelinedLoad.mockClear();

    // Re-arming the same pad must not re-decode what is already in memory
    audioPreloader.preloadArmedTrack([31], {
      profileId: 1,
      bankId: "2",
      padIndex: 3,
    });

    expect(pipelinedLoad).not.toHaveBeenCalled();
  });
});

describe("preloadCurrentPage", () => {
  it("loads every distinct sound on the page exactly once", async () => {
    // Two pads naming the same sound is ordinary — the same sting on a "go"
    // and a "reset" pad — and it must not be decoded twice.
    audioPreloader.preloadCurrentPage(
      [padWith([41, 42]), padWith([42, 43])],
      1,
      "bank-a",
    );

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());
    expect(batchedIds()[0]).toEqual([41, 42, 43]);
  });

  it("tolerates pads with no sounds on them", async () => {
    audioPreloader.preloadCurrentPage(
      [padWith([]), {} as unknown as PadConfiguration, padWith([44])],
      1,
      "bank-a",
    );

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());
    expect(batchedIds()[0]).toEqual([44]);
  });

  it("does nothing at all for an empty page", () => {
    audioPreloader.preloadCurrentPage([padWith([]), padWith([])], 1, "bank-a");

    expect(pipelinedLoad).not.toHaveBeenCalled();
    expect(audioPreloader.getStats().queueLength).toBe(0);
  });

  it("does not re-queue what is already decoded", async () => {
    audioPreloader.preloadCurrentPage([padWith([45])], 1, "bank-a");
    await vi.waitFor(() => expect(isAudioBufferCached(45)).toBe(true));
    pipelinedLoad.mockClear();

    audioPreloader.preloadCurrentPage([padWith([45])], 1, "bank-a");

    expect(pipelinedLoad).not.toHaveBeenCalled();
  });
});

describe("preloadAllConfigured", () => {
  it("puts recently played sounds in front of the rest", async () => {
    // The background sweep is the only place recency is used, and it is the
    // whole reason `trackPlayedFile` exists.
    audioPreloader.trackPlayedFile(52);

    audioPreloader.preloadAllConfigured([padWith([51, 52, 53])], 1);

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(2));
    expect(batchedIds()).toEqual([[52], [51, 53]]);
  });

  it("queues one batch when nothing has been played yet", async () => {
    audioPreloader.preloadAllConfigured([padWith([61, 62])], 1);

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());
    expect(batchedIds()).toEqual([[61, 62]]);
  });

  it("loads background work with the lower load concurrency", async () => {
    audioPreloader.preloadAllConfigured([padWith([63])], 1);

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());
    expect(pipelinedLoad.mock.calls[0][1]).toBe(6);
  });
});

describe("trackPlayedFile", () => {
  it("moves a replayed sound back to the front", async () => {
    audioPreloader.trackPlayedFile(71);
    audioPreloader.trackPlayedFile(72);
    audioPreloader.trackPlayedFile(71);

    // Both are "recent", so both go in the HIGH batch — the assertion that
    // matters is that 71 was not duplicated by being tracked twice.
    audioPreloader.preloadAllConfigured([padWith([71, 72])], 1);

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalled());
    expect(batchedIds()).toEqual([[71, 72]]);
  });

  it("remembers only the last twenty", async () => {
    for (let i = 0; i < 21; i++) audioPreloader.trackPlayedFile(100 + i);

    audioPreloader.preloadAllConfigured([padWith([100, 120])], 1);

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(2));
    // 100 fell off the end, so it is background work; 120 is still recent.
    expect(batchedIds()).toEqual([[120], [100]]);
  });
});

describe("preloadOnHover", () => {
  it("waits before loading, so a pointer crossing a pad costs nothing", async () => {
    vi.useFakeTimers();

    audioPreloader.preloadOnHover([81], {
      profileId: 1,
      bankId: "a",
      padIndex: 0,
    });

    expect(pipelinedLoad).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(pipelinedLoad).toHaveBeenCalledTimes(1);
  });

  it("does not even set a timer for sounds already decoded", async () => {
    vi.useFakeTimers();
    audioPreloader.preloadFiles([82], 0, { profileId: 1, bankId: "a" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(isAudioBufferCached(82)).toBe(true));
    pipelinedLoad.mockClear();

    audioPreloader.preloadOnHover([82], {
      profileId: 1,
      bankId: "a",
      padIndex: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(pipelinedLoad).not.toHaveBeenCalled();
  });
});

describe("when a load fails", () => {
  it("retries an urgent sound three times before giving up on it", async () => {
    vi.useFakeTimers();
    everythingFails();

    audioPreloader.preloadArmedTrack([91], {
      profileId: 1,
      bankId: "a",
      padIndex: 0,
    });

    // One attempt, then three retries on a rising backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(pipelinedLoad).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(4);

    // And then it stops, with the failure remembered.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(4);
    expect(isAudioBufferCached(91)).toBe(true);
    expect(getCachedAudioBuffer(91)).toBeNull();
  });

  it("retries background work only once", async () => {
    vi.useFakeTimers();
    everythingFails();

    audioPreloader.preloadAllConfigured([padWith([92])], 1);

    await vi.advanceTimersByTimeAsync(0);
    expect(pipelinedLoad).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(2);
    expect(getCachedAudioBuffer(92)).toBeNull();
  });

  it("retries every task when the decoder itself throws", async () => {
    // A rejection is different from a map of nulls: no per-file result comes
    // back at all, so every task in the batch has to be re-queued by hand.
    // Each gets its own timer, and each timer restarts the queue, so the
    // batch comes back as one request per file rather than as a batch.
    vi.useFakeTimers();
    pipelinedLoad.mockRejectedValue(new Error("audio context is closed"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    audioPreloader.preloadAllConfigured([padWith([93, 94])], 1);

    await vi.advanceTimersByTimeAsync(0);
    expect(batchedIds()).toEqual([[93, 94]]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(batchedIds().slice(1)).toEqual([[93], [94]]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pipelinedLoad).toHaveBeenCalledTimes(3);
    expect(getCachedAudioBuffer(93)).toBeNull();
    expect(getCachedAudioBuffer(94)).toBeNull();
  });
});

describe("the queue", () => {
  it("takes urgent work before background work already queued", async () => {
    // The page-switch case: a background sweep is in flight, the operator
    // opens a bank, and the sounds on it must not wait for the whole profile.
    const release = holdNextLoad();

    audioPreloader.preloadAllConfigured([padWith([201, 202])], 1);
    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(1));

    audioPreloader.preloadFiles([203], 3, { profileId: 1, bankId: "a" });
    audioPreloader.preloadArmedTrack([204], {
      profileId: 1,
      bankId: "a",
      padIndex: 0,
    });
    release();

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(3));
    expect(batchedIds().slice(1)).toEqual([[204], [203]]);
  });

  it("splits a large page into chunks so priority can be re-checked", async () => {
    const many = Array.from({ length: 13 }, (_, i) => 300 + i);

    audioPreloader.preloadFiles(many, 0, { profileId: 1, bankId: "a" });

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(2));
    expect(batchedIds()[0]).toHaveLength(12);
    expect(batchedIds()[1]).toHaveLength(1);
  });

  it("re-queuing a file at a new priority does not load it twice", async () => {
    const release = holdNextLoad();

    audioPreloader.preloadFiles([401, 402], 3, { profileId: 1, bankId: "a" });
    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(1));
    audioPreloader.preloadFiles([403], 3, { profileId: 1, bankId: "a" });
    audioPreloader.preloadFiles([403], 0, { profileId: 1, bankId: "a" });
    release();

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(2));
    expect(batchedIds()[1]).toEqual([403]);
  });

  it("drops a sound that got decoded between queueing and its turn", async () => {
    // The second cached check, in the chunk loop, is what covers this: a
    // keypress can decode the file while the queue is busy with another chunk.
    const release = holdNextLoad();

    audioPreloader.preloadFiles([501], 0, { profileId: 1, bankId: "a" });
    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(1));
    audioPreloader.preloadFiles([502], 0, { profileId: 1, bankId: "a" });
    cacheAudioBuffer(502, fakeBuffer());
    release();

    await vi.waitFor(() =>
      expect(audioPreloader.getStats().queueLength).toBe(0),
    );
    expect(batchedIds()).toEqual([[501]]);
  });

  it("clearQueue drops everything still waiting", async () => {
    const release = holdNextLoad();

    audioPreloader.preloadFiles([601], 0, { profileId: 1, bankId: "a" });
    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(1));
    audioPreloader.preloadFiles([602, 603], 3, { profileId: 1, bankId: "a" });
    expect(audioPreloader.getStats().queueLength).toBe(2);

    audioPreloader.clearQueue();
    release();

    await vi.waitFor(() =>
      expect(audioPreloader.getStats().queueLength).toBe(0),
    );
    expect(batchedIds()).toEqual([[601]]);
  });

  it("pausePreloading holds work back until it is resumed", async () => {
    audioPreloader.pausePreloading();

    audioPreloader.preloadFiles([701], 0, { profileId: 1, bankId: "a" });
    await vi.waitFor(() =>
      expect(audioPreloader.getStats().queueLength).toBe(1),
    );
    expect(pipelinedLoad).not.toHaveBeenCalled();

    audioPreloader.resumePreloading();

    await vi.waitFor(() => expect(pipelinedLoad).toHaveBeenCalledTimes(1));
  });
});

describe("getStats", () => {
  it("counts what was asked for, what landed and what is still waiting", async () => {
    const before = audioPreloader.getStats();

    audioPreloader.preloadFiles([801, 802], 0, { profileId: 1, bankId: "a" });

    await vi.waitFor(() => expect(isAudioBufferCached(802)).toBe(true));
    const after = audioPreloader.getStats();
    expect(after.totalRequested - before.totalRequested).toBe(2);
    expect(after.totalCompleted - before.totalCompleted).toBe(2);
    expect(after.queueLength).toBe(0);
    expect(after.averageLoadTime).toBeGreaterThanOrEqual(0);
  });

  it("counts a permanently failed file as failed", async () => {
    vi.useFakeTimers();
    everythingFails();
    const before = audioPreloader.getStats();

    audioPreloader.preloadAllConfigured([padWith([803])], 1);
    await vi.advanceTimersByTimeAsync(5000);

    expect(audioPreloader.getStats().totalFailed - before.totalFailed).toBe(1);
  });
});
