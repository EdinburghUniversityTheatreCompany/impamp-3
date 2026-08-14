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
  getAudioFileIdsForProfile: vi.fn(),
  updateAudioFileLoudness: vi.fn(),
  findUnanalysedAudioFileIds: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  getCachedAudioBuffer: vi.fn(),
}));

const decoderMocks = vi.hoisted(() => ({
  decodeAudioBlob: vi.fn(),
}));

const analyseMocks = vi.hoisted(() => ({
  analyseAudioBuffer: vi.fn(),
}));

const loudnessCacheMocks = vi.hoisted(() => ({
  setCachedLoudness: vi.fn(),
  warmLoudnessCache: vi.fn(),
}));

vi.mock("@/lib/db", () => dbMocks);
vi.mock("@/lib/audio/cache", () => cacheMocks);
vi.mock("@/lib/audio/decoder", () => decoderMocks);
vi.mock("./analyse", () => analyseMocks);
vi.mock("./cache", () => loudnessCacheMocks);

const {
  analyseAndStore,
  clearFailedAnalysis,
  nextBackfillBatch,
  refreshProfileLoudness,
  runBackfill,
  shouldAnalyse,
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
  cacheMocks.getCachedAudioBuffer.mockReturnValue(null);
}

describe("failed-analysis filtering", () => {
  useSyntheticIdleWindow();

  beforeEach(() => {
    resetPipelineMocks();
  });

  it("stops offering a file that failed to decode this session", async () => {
    decoderMocks.decodeAudioBlob.mockRejectedValue(new Error("corrupt file"));

    // File 1 fails to decode once; analyseAndStore records it as failed for
    // this session. Nothing is written to the DB on a failed attempt, so
    // findUnanalysedAudioFileIds would keep reporting it as unanalysed —
    // this in-memory filter is what stops it from being retried forever.
    await expect(analyseAndStore(1)).resolves.toBeNull();

    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1, 2, 3]);
    dbMocks.getAudioFile.mockClear();

    await runBackfill();

    const attemptedIds = dbMocks.getAudioFile.mock.calls
      .map((args: unknown[]) => args[0] as number)
      .sort((a, b) => a - b);
    expect(attemptedIds).toEqual([2, 3]);
  });

  it("clearFailedAnalysis lets a previously failed file be retried", async () => {
    decoderMocks.decodeAudioBlob.mockRejectedValue(new Error("corrupt file"));
    await expect(analyseAndStore(1)).resolves.toBeNull();

    clearFailedAnalysis();

    dbMocks.findUnanalysedAudioFileIds.mockResolvedValue([1]);
    dbMocks.getAudioFile.mockClear();

    await runBackfill();

    const attemptedIds = dbMocks.getAudioFile.mock.calls.map(
      (args: unknown[]) => args[0] as number,
    );
    expect(attemptedIds).toEqual([1]);
  });
});

describe("runBackfill coalescing", () => {
  useSyntheticIdleWindow();

  function fakeAnalysis(): LoudnessAnalysis {
    return {
      algoVersion: LOUDNESS_ALGO_VERSION,
      sampleRate: 48000,
      duration: 1,
      blockMeanSquare: new Float32Array(0),
      hopTruePeak: new Float32Array(0),
    };
  }

  beforeEach(() => {
    resetPipelineMocks();
    decoderMocks.decodeAudioBlob.mockResolvedValue({});
    analyseMocks.analyseAudioBuffer.mockReturnValue(fakeAnalysis());
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

    const attemptedIds = dbMocks.getAudioFile.mock.calls.map(
      (args: unknown[]) => args[0] as number,
    );
    // Under the old supersede logic, a second concurrent caller could take
    // over the generation token and leave the first caller's work undone.
    expect(attemptedIds).toContain(1);
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
