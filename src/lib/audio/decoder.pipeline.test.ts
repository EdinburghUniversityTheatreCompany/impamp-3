/**
 * The pipelined preloader's decode-slot accounting.
 *
 * A task used to join `activeDecodes` and *then* wait for that same set to
 * drain, so every member of a batch waited on a set it was itself in. Once a
 * batch reached the decode limit nothing could ever complete, the preload
 * promise never settled, and — because the in-flight entry is held across the
 * wait — pressing a pad whose sound was in that batch joined a promise that
 * never resolved. The pad silently did nothing until the page was reloaded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Resolvers for the pending decodes, so a test decides when each finishes. */
let pendingDecodes: Array<() => void> = [];
/** How many decodes have been entered but not yet resolved. */
let concurrentDecodes = 0;
/** The high-water mark of `concurrentDecodes` across a run. */
let peakConcurrency = 0;

vi.mock("../db", () => ({
  getAudioFile: vi.fn(async (id: number) => ({
    id,
    name: `file-${id}`,
    blob: { size: 8, arrayBuffer: async () => new ArrayBuffer(8) },
  })),
}));

vi.mock("./cache", () => ({
  getCachedAudioBuffer: () => undefined,
  cacheAudioBuffer: () => {},
  isAudioBufferCached: () => false,
}));

vi.mock("./context", () => ({
  getAudioContext: () => ({
    decodeAudioData: () => {
      concurrentDecodes++;
      peakConcurrency = Math.max(peakConcurrency, concurrentDecodes);
      return new Promise((resolve) => {
        pendingDecodes.push(() => {
          concurrentDecodes--;
          resolve({ duration: 1 } as unknown as AudioBuffer);
        });
      });
    },
  }),
}));

/** Lets every queued microtask run, so pending awaits make progress. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Releases decodes until none are left waiting, or `rounds` is exhausted. */
async function drainDecodes(rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    const next = pendingDecodes.shift();
    if (!next) {
      await settle();
      if (pendingDecodes.length === 0) return;
      continue;
    }
    next();
    await settle();
  }
}

/**
 * Rejects a promise that has not settled after the microtask queue is drained.
 * Real timers would make a deadlock look like slowness; this makes it a failure.
 */
async function resolvesWithoutTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.then((value) => {
    settled = true;
    return value;
  });
  await drainDecodes();
  if (!settled) {
    throw new Error(
      "deadlock: the promise never settled even though every decode was released",
    );
  }
  return tracked;
}

beforeEach(() => {
  pendingDecodes = [];
  concurrentDecodes = 0;
  peakConcurrency = 0;
  vi.resetModules();
});

describe("loadAndDecodeAudioPipelined", () => {
  it("completes a batch smaller than the decode limit", async () => {
    const { loadAndDecodeAudioPipelined } = await import("./decoder");

    const result = await resolvesWithoutTimers(
      loadAndDecodeAudioPipelined([1, 2], 6, 4),
    );

    expect(result.size).toBe(2);
  });

  it("completes a batch that exactly reaches the decode limit", async () => {
    // The deadlock's boundary: with `loadBatchSize` 6 and a decode limit of 4,
    // every one of the six was added to the set before any of them looked at
    // it, so all six waited for each other.
    const { loadAndDecodeAudioPipelined } = await import("./decoder");

    const result = await resolvesWithoutTimers(
      loadAndDecodeAudioPipelined([1, 2, 3, 4, 5, 6], 6, 4),
    );

    expect(result.size).toBe(6);
    expect([...result.values()].every((buffer) => buffer !== null)).toBe(true);
  });

  it("completes a batch on a machine whose decode limit is the batch size", async () => {
    // `getDecodeConcurrency` clamps to 6 and background batches are 6, so an
    // 8-core machine hits limit === batch size on every ordinary preload.
    const { loadAndDecodeAudioPipelined } = await import("./decoder");

    const result = await resolvesWithoutTimers(
      loadAndDecodeAudioPipelined([1, 2, 3, 4, 5, 6], 6, 6),
    );

    expect(result.size).toBe(6);
  });

  it("never runs more decodes at once than the limit allows", async () => {
    // Guards the other direction: dropping the limit would also make the
    // deadlock tests pass, at the cost of the concurrency cap they protect.
    const { loadAndDecodeAudioPipelined } = await import("./decoder");

    await resolvesWithoutTimers(
      loadAndDecodeAudioPipelined([1, 2, 3, 4, 5, 6, 7, 8], 8, 3),
    );

    expect(peakConcurrency).toBeLessThanOrEqual(3);
    expect(peakConcurrency).toBeGreaterThan(1);
  });

  it("lets a pad trigger join a preload that is waiting for a decode slot", async () => {
    // The user-visible half. The in-flight entry is deliberately held across
    // the slot wait so a trigger shares the preload's decode instead of
    // starting a second one — which means a stuck wait strands the keypress.
    const { loadAndDecodeAudioPipelined, loadAndDecodeAudioInstant } =
      await import("./decoder");

    void loadAndDecodeAudioPipelined([1, 2, 3, 4, 5, 6], 6, 2);
    await settle();

    const triggered = await resolvesWithoutTimers(loadAndDecodeAudioInstant(1));

    expect(triggered).not.toBeNull();
  });
});
