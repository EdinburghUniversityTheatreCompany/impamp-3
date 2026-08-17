/**
 * What happens when the loudness worker stops answering.
 *
 * The fallback to the main thread is deliberately silent — better slow than
 * wrong — which means every failure mode here is invisible from the outside.
 * The two that matter are a round trip that never comes back (nothing bounded
 * it, so `analyseAndStore` awaited forever and took the whole backfill queue
 * with it) and a single error latching the worker off for the rest of the
 * session.
 *
 * Vitest's node environment has no `Worker`, which is what makes this
 * testable: a fake one can be installed as the global and driven by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoudnessAnalysis } from "./types";

const analyseMocks = vi.hoisted(() => ({
  analyseLoudness: vi.fn(),
}));

vi.mock("./analyse", () => analyseMocks);

interface PostedRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

/** A `Worker` that does nothing until a test tells it to. */
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: PostedRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: PostedRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answers the request at `index` as the real worker would. */
  reply(index = 0, analysis: LoudnessAnalysis = workerAnalysis()): void {
    const request = this.posted[index];
    this.onmessage?.({
      data: { id: request.id, ok: true, analysis },
    } as MessageEvent);
  }
}

function workerAnalysis(): LoudnessAnalysis {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration: 10,
    blockMeanSquare: new Float32Array(1),
    hopTruePeak: new Float32Array(1),
  };
}

const MAIN_THREAD_RESULT = workerAnalysis();

function fakeBuffer(durationSeconds = 10): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate: 48000,
    duration: durationSeconds,
    getChannelData: () => new Float32Array(8),
  } as unknown as AudioBuffer;
}

const {
  analyseAudioBufferOffThread,
  loudnessWorkerTimeoutMs,
  resetLoudnessWorker,
  MAX_CONSECUTIVE_WORKER_FAILURES,
} = await import("./analyseOffThread");

/** The generous side of any deadline this module can produce for one file. */
const PAST_ANY_DEADLINE = loudnessWorkerTimeoutMs(10) * 4;

/**
 * Starts an analysis and reports whether it has settled, so a test can prove a
 * hang without hanging itself: `await expect(promise)` on a promise that never
 * resolves fails only by test timeout, which is indistinguishable from a slow
 * machine.
 */
function startAnalysis(buffer: AudioBuffer = fakeBuffer()) {
  const state = { settled: false, value: null as LoudnessAnalysis | null };
  const promise = analyseAudioBufferOffThread(buffer).then((analysis) => {
    state.settled = true;
    state.value = analysis;
    return analysis;
  });
  return { state, promise };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeWorker.instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  analyseMocks.analyseLoudness.mockReturnValue(MAIN_THREAD_RESULT);
  resetLoudnessWorker();
});

afterEach(() => {
  resetLoudnessWorker();
  delete (globalThis as { Worker?: unknown }).Worker;
  vi.useRealTimers();
});

describe("a worker round trip that never comes back", () => {
  it("gives up and measures on the main thread instead of awaiting forever", async () => {
    const { state, promise } = startAnalysis();

    await vi.advanceTimersByTimeAsync(PAST_ANY_DEADLINE);

    // Unbounded, this never settles — and `analyseAndStore` awaits it, so the
    // backfill sweep it belongs to never reschedules and `backfillInFlight`
    // never clears. Every later re-analyse joins that dead promise.
    expect(state.settled).toBe(true);
    await expect(promise).resolves.toBe(MAIN_THREAD_RESULT);
    expect(analyseMocks.analyseLoudness).toHaveBeenCalledTimes(1);
  });

  it("does not give up before the deadline it promised", async () => {
    const { state } = startAnalysis();

    await vi.advanceTimersByTimeAsync(loudnessWorkerTimeoutMs(10) - 1000);

    expect(state.settled).toBe(false);
    expect(analyseMocks.analyseLoudness).not.toHaveBeenCalled();
  });

  it("allows more time for a longer file, since the work scales with it", () => {
    expect(loudnessWorkerTimeoutMs(3600)).toBeGreaterThan(
      loudnessWorkerTimeoutMs(30),
    );
  });

  it("gives a request queued behind others room for the whole queue", async () => {
    // The worker is serial, so a request's clock starts when it is posted and
    // not when the worker reaches it. A deadline that ignored what is already
    // queued would cancel healthy work during a bulk import.
    startAnalysis(fakeBuffer(600));
    const { state } = startAnalysis(fakeBuffer(10));

    await vi.advanceTimersByTimeAsync(loudnessWorkerTimeoutMs(10) + 1000);

    expect(state.settled).toBe(false);
  });
});

describe("one worker error", () => {
  it("does not disable the worker for the rest of the session", async () => {
    const { promise } = startAnalysis();
    FakeWorker.instances[0].onerror?.({});
    await promise;

    // A fresh request must reach a worker again. Latching after a single
    // failure quietly restores the main-thread freeze the worker exists to
    // remove, with no signal anywhere that it happened.
    const second = startAnalysis();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].posted).toHaveLength(1);

    FakeWorker.instances[1].reply();
    await second.promise;
    expect(analyseMocks.analyseLoudness).toHaveBeenCalledTimes(1);
  });

  it("settles the request that was in flight, rather than stranding it", async () => {
    const { state, promise } = startAnalysis();

    FakeWorker.instances[0].onerror?.({});
    await promise;

    expect(state.settled).toBe(true);
    expect(state.value).toBe(MAIN_THREAD_RESULT);
  });
});

describe("a worker that keeps failing", () => {
  it("is eventually abandoned instead of retried forever", async () => {
    for (
      let attempt = 0;
      attempt < MAX_CONSECUTIVE_WORKER_FAILURES;
      attempt++
    ) {
      const { promise } = startAnalysis();
      FakeWorker.instances[attempt].onerror?.({});
      await promise;
    }

    const created = FakeWorker.instances.length;
    await startAnalysis().promise;

    // Nothing new was constructed: a worker that cannot load will never load,
    // and paying a construction plus a rejection per file is worse than the
    // fallback the caller already has.
    expect(FakeWorker.instances).toHaveLength(created);
  });

  it("forgets the failures once one succeeds", async () => {
    for (
      let attempt = 0;
      attempt < MAX_CONSECUTIVE_WORKER_FAILURES - 1;
      attempt++
    ) {
      const { promise } = startAnalysis();
      FakeWorker.instances[attempt].onerror?.({});
      await promise;
    }

    const good = startAnalysis();
    FakeWorker.instances.at(-1)!.reply();
    await good.promise;

    // Failures that are separated by a success are not a broken worker, so
    // the count that leads to abandonment must start again.
    for (
      let attempt = 0;
      attempt < MAX_CONSECUTIVE_WORKER_FAILURES - 1;
      attempt++
    ) {
      const { promise } = startAnalysis();
      FakeWorker.instances.at(-1)!.onerror?.({});
      await promise;
    }

    const after = FakeWorker.instances.length;
    const next = startAnalysis();
    expect(FakeWorker.instances.length).toBe(after + 1);
    FakeWorker.instances.at(-1)!.reply();
    await next.promise;
  });
});

describe("a reply that cannot be deserialised", () => {
  it("settles the pending request instead of leaving it in the map", async () => {
    const { state, promise } = startAnalysis();

    // `messageerror` is the other way a round trip ends without an
    // `onmessage`: the reply arrived but could not be structured-cloned back.
    FakeWorker.instances[0].onmessageerror?.({});
    await promise;

    expect(state.settled).toBe(true);
    expect(analyseMocks.analyseLoudness).toHaveBeenCalledTimes(1);
  });
});

describe("resetLoudnessWorker", () => {
  it("rejects what was in flight rather than dropping it", async () => {
    const { state, promise } = startAnalysis();

    resetLoudnessWorker();
    await promise;

    // Clearing the pending map without rejecting leaves whatever was awaiting
    // it hanging for good — the same wedge as an unanswered round trip, from
    // a test seam.
    expect(state.settled).toBe(true);
    expect(state.value).toBe(MAIN_THREAD_RESULT);
  });
});

describe("the happy path", () => {
  it("uses the worker's answer and never touches the main thread", async () => {
    const analysis = workerAnalysis();
    const { promise } = startAnalysis();

    FakeWorker.instances[0].reply(0, analysis);

    await expect(promise).resolves.toBe(analysis);
    expect(analyseMocks.analyseLoudness).not.toHaveBeenCalled();
  });

  it("does not leave a timer behind once the worker has answered", async () => {
    const { promise } = startAnalysis();
    FakeWorker.instances[0].reply();
    await promise;

    // A deadline that outlives its request would recycle a healthy worker
    // minutes later and reject whatever was in flight by then.
    await vi.advanceTimersByTimeAsync(PAST_ANY_DEADLINE);
    expect(FakeWorker.instances[0].terminated).toBe(false);
    expect(analyseMocks.analyseLoudness).not.toHaveBeenCalled();
  });
});
