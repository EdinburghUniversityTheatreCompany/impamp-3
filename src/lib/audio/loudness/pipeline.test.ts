import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOUDNESS_ALGO_VERSION } from "./constants";

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

describe("failed-analysis filtering", () => {
  const globalWithWindow = globalThis as unknown as {
    window?: unknown;
    requestIdleCallback?: (cb: () => void) => number;
  };
  const hadWindow = "window" in globalThis;

  beforeEach(() => {
    vi.clearAllMocks();
    clearFailedAnalysis();

    // runBackfill (like every IndexedDB-touching function here) guards on
    // `typeof window !== "undefined"` for SSR-safety. Vitest's node
    // environment has no `window`, so stub a minimal one to get past the
    // guard and exercise the function for real.
    if (!hadWindow) globalWithWindow.window = {};

    // Make the idle scheduler run synchronously so backfill batches resolve
    // immediately instead of waiting on the setTimeout(200ms) fallback.
    globalWithWindow.requestIdleCallback = (cb: () => void) => {
      cb();
      return 0;
    };

    dbMocks.getAudioFile.mockImplementation(async (id: number) =>
      fakeAudioFile(id),
    );
    cacheMocks.getCachedAudioBuffer.mockReturnValue(null);
  });

  afterEach(() => {
    if (!hadWindow) delete globalWithWindow.window;
    delete globalWithWindow.requestIdleCallback;
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
