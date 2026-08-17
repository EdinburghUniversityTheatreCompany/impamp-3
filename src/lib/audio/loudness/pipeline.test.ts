import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOUDNESS_ALGO_VERSION } from "./constants";
import type { LoudnessAnalysis } from "./types";

// `analyseAndStore` and `runBackfill` touch IndexedDB, the audio buffer
// cache, the decoder, and the analysis engine — none of which exist in
// Vitest's node environment. Stub all of it so the pipeline's own control
// flow (in particular the failed-analysis filter) can be exercised for real,
// following the same vi.hoisted + vi.mock pattern used elsewhere in this repo
// (see src/lib/serverAudio/transfer.test.ts).
const dbMocks = vi.hoisted(() => ({
  getAudioFile: vi.fn(),
  getAudioFileMetadata: vi.fn(),
  getAudioFileIdsForProfile: vi.fn(),
  updateAudioFileLoudness: vi.fn(),
  findUnanalysedAudioFileIds: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  getCachedAudioBuffer: vi.fn(),
}));

const decoderMocks = vi.hoisted(() => ({
  decodeAudioBlob: vi.fn(),
  loadAndDecodeAudio: vi.fn(),
}));

const analyseMocks = vi.hoisted(() => ({
  analyseAudioBufferOffThread: vi.fn(),
}));

const loudnessCacheMocks = vi.hoisted(() => ({
  setCachedLoudness: vi.fn(),
  warmLoudnessCache: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/audio/cache", () => cacheMocks);
vi.mock("@/lib/audio/decoder", () => decoderMocks);
vi.mock("./analyseOffThread", () => analyseMocks);
vi.mock("./cache", () => loudnessCacheMocks);

const {
  analyseAndStore,
  clearFailedAnalysis,
  nextBackfillBatch,
  refreshProfileLoudness,
  runBackfill,
  shouldAnalyse,
  subscribeToBackfillProgress,
} = await import("./pipeline");

function fakeAudioFile(id: number) {
  return {
    id,
    blob: new Blob(),
    name: `file-${id}`,
    type: "audio/wav",
    createdAt: new Date(),
  };
}

function fakeAnalysis(): LoudnessAnalysis {
  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate: 48000,
    duration: 1,
    blockMeanSquare: new Float32Array(0),
    hopTruePeak: new Float32Array(0),
  };
}

describe("shouldAnalyse", () => {
  it("analyses a file with no analysis", () => {
    expect(shouldAnalyse(undefined)).toBe(true);
  });

  it("re-analyses a file from an older algorithm version", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION - 1,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(true);
  });

  it("leaves a current analysis alone", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(false);
  });
});

describe("nextBackfillBatch", () => {
  it("takes at most the batch size", () => {
    expect(nextBackfillBatch([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });

  it("takes everything when fewer remain than the batch size", () => {
    expect(nextBackfillBatch([1], 3)).toEqual([1]);
  });

  it("returns empty for an empty queue", () => {
    expect(nextBackfillBatch([], 3)).toEqual([]);
  });
});

/**
 * Stubs `window` (Vitest's node environment has none, and runBackfill /
 * loadProfileLoudness guard on it for SSR-safety) and makes the idle
 * scheduler run synchronously, so backfill batches resolve immediately
 * instead of waiting on the setTimeout(200ms) fallback. Registers
 * beforeEach/afterEach on whichever describe block calls it — shared by
 * every describe below that exercises `runBackfill` for real.
 */
function useSyntheticIdleWindow(): void {
  const globalWithWindow = globalThis as unknown as {
    window?: unknown;
    requestIdleCallback?: (cb: () => void) => number;
  };
  const hadWindow = "window" in globalThis;

  beforeEach(() => {
    if (!hadWindow) globalWithWindow.window = {};
    globalWithWindow.requestIdleCallback = (cb: () => void) => {
      cb();
      return 0;
    };
  });

  afterEach(() => {
    if (!hadWindow) delete globalWithWindow.window;
    delete globalWithWindow.requestIdleCallback;
  });
}

/** Common mock reset shared by every describe below that calls `runBackfill`. */
function resetPipelineMocks(): void {
  vi.clearAllMocks();
  clearFailedAnalysis();
  dbMocks.getAudioFile.mockImplementation(async (id: number) =>
    fakeAudioFile(id),
  );
  // Mirrors getAudioFile, so a test that stubs one gets a consistent answer
  // from both without having to say it twice.
  dbMocks.getAudioFileMetadata.mockImplementation(
    async (ids: Iterable<number>) => {
      const map = new Map();
      for (const id of ids) {
        const file = await dbMocks.getAudioFile(id);
        if (file) map.set(id, { id, ...file });
      }
      return map;
    },
  );
  cacheMocks.getCachedAudioBuffer.mockReturnValue(null);
  decoderMocks.loadAndDecodeAudio.mockResolvedValue({} as AudioBuffer);
  analyseMocks.analyseAudioBufferOffThread.mockResolvedValue(fakeAnalysis());
}

describe("failed-analysis filtering", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
  });

  /** Which files the pipeline actually tried to decode, in ascending order. */
  function attemptedIds(): number[] {
    return decoderMocks.loadAndDecodeAudio.mock.calls
      .map((args: unknown[]) => args[0] as number)
      .sort((a, b) => a - b);
  }

  it("stops offering a file that failed to decode this session", async () => {
    decoderMocks.loadAndDecodeAudio.mockResolvedValue(null);

    // File 1 fails to decode once; analyseAndStore records it as failed for
    // this session. Nothing is written to the DB on a failed attempt, so
    // findUnanalysedAudioFileIds would keep reporting it as unanalysed —
    // this in-memory filter is what stops it from being retried forever.
    await expect(analyseAndStore(1)).resolves.toBeNull();

    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1, 2, 3]);
    decoderMocks.loadAndDecodeAudio.mockClear();

    await runBackfill();

    expect(attemptedIds()).toEqual([2, 3]);
  });

  it("clearFailedAnalysis lets a previously failed file be retried", async () => {
    decoderMocks.loadAndDecodeAudio.mockResolvedValue(null);
    await expect(analyseAndStore(1)).resolves.toBeNull();

    clearFailedAnalysis();

    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);
    decoderMocks.loadAndDecodeAudio.mockClear();

    await runBackfill();

    expect(attemptedIds()).toEqual([1]);
  });
});

describe("analyseAndStore and the decode it needs", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
  });

  it("goes through the shared loader rather than decoding on its own", async () => {
    await analyseAndStore(1);

    // `decodeAudioBlob` is the raw decoder: it neither joins the in-flight
    // registry nor caches what it produces. Using it meant a file being
    // decoded for playback at the same moment was decoded a second time here,
    // and the second decode was thrown away.
    expect(decoderMocks.loadAndDecodeAudio).toHaveBeenCalledWith(1);
    expect(decoderMocks.decodeAudioBlob).not.toHaveBeenCalled();
  });

  it("shares one decode between two callers asking for the same file", async () => {
    const both = await Promise.all([analyseAndStore(4), analyseAndStore(4)]);

    // `addAudioFile` fires an analysis per file while the backfill sweep is
    // also picking that file up, so the same id genuinely arrives twice.
    expect(decoderMocks.loadAndDecodeAudio).toHaveBeenCalledTimes(1);
    expect(both[0]).toBe(both[1]);
  });

  it("lets a later caller start again once the first has finished", async () => {
    await analyseAndStore(4);
    await analyseAndStore(4);

    expect(decoderMocks.loadAndDecodeAudio).toHaveBeenCalledTimes(2);
  });

  /**
   * Makes every decode hang until released, and returns the release queue.
   *
   * The slots are module state, so a test that leaves one held would wedge
   * every test after it — hence releasing rather than abandoning.
   */
  function controllableDecodes(): Array<(buffer: AudioBuffer) => void> {
    const releases: Array<(buffer: AudioBuffer) => void> = [];
    decoderMocks.loadAndDecodeAudio.mockImplementation(
      () => new Promise<AudioBuffer>((resolve) => releases.push(resolve)),
    );
    return releases;
  }

  /**
   * Releases whatever is in flight, round by round, until `all` settles.
   *
   * Bounded, so a genuine stall fails the test rather than hanging it.
   */
  async function drain<T>(
    releases: Array<(buffer: AudioBuffer) => void>,
    all: Promise<T>,
  ): Promise<T> {
    let settled = false;
    const done = all.then((value) => {
      settled = true;
      return value;
    });

    for (let round = 0; round < 50 && !settled; round++) {
      for (const release of releases.splice(0)) release({} as AudioBuffer);
      // A macrotask, not a microtask: each released analysis still has to walk
      // through the worker call and the store write before it frees its slot.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return done;
  }

  it("caps how many files are decoded and measured at once", async () => {
    const releases = controllableDecodes();
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const all = Promise.all(ids.map((id) => analyseAndStore(id)));
    await Promise.resolve();
    await Promise.resolve();

    // The bulk-import modal calls `addAudioFile` in a loop and each call fans
    // out an analysis with no gate at all. Each one holds a fully decoded
    // buffer plus a full per-channel copy until the single worker reaches it,
    // and the worker is serial — so the copies queue up rather than draining.
    // Forty three-minute stereo files is roughly 2.7 GB resident.
    expect(decoderMocks.loadAndDecodeAudio).toHaveBeenCalledTimes(3);

    await drain(releases, all);
  });

  it("lets the queue drain as slots come free", async () => {
    const releases = controllableDecodes();
    const ids = [1, 2, 3, 4, 5, 6];
    const all = Promise.all(ids.map((id) => analyseAndStore(id)));

    // A gate that handed a freed slot back to a counter rather than to the
    // next waiter would stall part way through this instead.
    await expect(drain(releases, all)).resolves.toHaveLength(ids.length);
    expect(decoderMocks.loadAndDecodeAudio).toHaveBeenCalledTimes(ids.length);
  });
});

describe("runBackfill coalescing", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
  });

  it("returns the in-flight promise to a caller that arrives mid-run, and does one coalesced re-run for it", async () => {
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);

    const first = runBackfill();
    const second = runBackfill(); // arrives while `first` is still in flight

    expect(second).toBe(first);

    await first;
    await second;

    // One sweep for the original call, plus exactly one coalesced re-run for
    // the request that arrived mid-flight — not one (which would lose the
    // second caller's request) and not more than two (which would mean it
    // wasn't coalesced into a single follow-up pass).
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(2);
  });

  it("honours a rerun request exactly once, regardless of how many callers asked for it mid-flight", async () => {
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);

    const first = runBackfill();
    void runBackfill();
    void runBackfill();
    void runBackfill();

    await first;

    // Three extra callers while the first run was in flight still produce
    // only one coalesced re-run: a boolean "rerun requested" flag, not a
    // counted queue of reruns — a loop that grew with the caller count would
    // fail this.
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh, independent run once the previous coalesced sequence has fully finished", async () => {
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);

    const first = runBackfill();
    const second = runBackfill(); // coalesces into one re-run after `first`
    await first;
    await second;
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(2);

    const third = runBackfill();
    expect(third).not.toBe(first);
    await third;
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(3);
  });

  it("actually analyses the file both coalesced callers were waiting on, rather than dropping it", async () => {
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);

    const first = runBackfill();
    const second = runBackfill();
    await first;
    await second;

    const attempted = decoderMocks.loadAndDecodeAudio.mock.calls.map(
      (args: unknown[]) => args[0] as number,
    );
    // Under the old supersede logic, a second concurrent caller could take
    // over the generation token and leave the first caller's work undone.
    expect(attempted).toContain(1);
  });
});

describe("runBackfill survives a throwing progress listener", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
  });

  it("still resolves, and clears backfillInFlight, when a subscriber throws", async () => {
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);

    // Skip the synchronous call subscribeToBackfillProgress makes on
    // subscribe (fires with whatever progress is already current) and throw
    // only on the call the sweep itself triggers after analysing a batch —
    // the exact path `emitBackfillProgress` drives from inside
    // `runBackfillSweep`'s `.then()`.
    let calls = 0;
    const unsubscribe = subscribeToBackfillProgress(() => {
      calls++;
      if (calls > 1) throw new Error("boom");
    });

    // Without the `.catch(() => resolve())` on that `.then()` chain, this
    // would hang forever: `step` never gets scheduled again, so the sweep's
    // promise never settles.
    await expect(runBackfill()).resolves.toBeUndefined();
    unsubscribe();

    // If `backfillInFlight` had been left set, this second call would join
    // the dead promise instead of starting a fresh sweep.
    dbMocks.findUnanalysedAudioFileIds.mockClear();
    await expect(runBackfill()).resolves.toBeUndefined();
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(1);
  });
});

describe("refreshProfileLoudness", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
    dbMocks.getAudioFileIdsForProfile.mockResolvedValue(new Set());
    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([]);
  });

  it("warms the cache, runs the backfill, then warms the cache again", async () => {
    await refreshProfileLoudness(7);

    expect(dbMocks.getAudioFileIdsForProfile).toHaveBeenCalledWith(7);
    expect(dbMocks.getAudioFileIdsForProfile).toHaveBeenCalledTimes(2);
    expect(dbMocks.findUnanalysedAudioFileIds).toHaveBeenCalledTimes(1);
    expect(loudnessCacheMocks.warmLoudnessCache).toHaveBeenCalledTimes(2);
  });
});
