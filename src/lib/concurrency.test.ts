import { describe, expect, it } from "vitest";
import { DEFAULT_CONCURRENCY, forEachWithConcurrency } from "./concurrency";

/** A promise the test resolves by hand, so overlap can be observed. */
function gate() {
  let open: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { passed, open: open! };
}

describe("forEachWithConcurrency", () => {
  it("visits every item exactly once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];

    await forEachWithConcurrency(items, 4, async (item) => {
      seen.push(item);
    });

    expect(seen).toHaveLength(50);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("passes each item its own index", async () => {
    const pairs: Array<[string, number]> = [];

    await forEachWithConcurrency(["a", "b", "c"], 2, async (item, index) => {
      pairs.push([item, index]);
    });

    expect(pairs.sort()).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("really does run several at once", async () => {
    // The point of the module. Without this, a "pool" that quietly awaited
    // each item in turn would pass every other test here.
    const held = gate();
    let running = 0;
    let peak = 0;

    const run = forEachWithConcurrency([1, 2, 3, 4, 5, 6], 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await held.passed;
      running--;
    });

    // Let the workers start and block.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(3);

    held.open();
    await run;
  });

  it("never exceeds the width it was given", async () => {
    let running = 0;
    let peak = 0;

    await forEachWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      5,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running--;
      },
    );

    expect(peak).toBeLessThanOrEqual(5);
  });

  it("does not start more workers than there are items", async () => {
    let starts = 0;

    await forEachWithConcurrency([1, 2], 16, async () => {
      starts++;
    });

    expect(starts).toBe(2);
  });

  it("takes a slow item off the shared cursor rather than pre-splitting", async () => {
    // Audio files differ enormously in size. A static split leaves one worker
    // holding every large file while the others idle; a shared cursor does
    // not. Item 0 is slow, so the other worker should take most of the rest.
    const takenBySecondWorker: number[] = [];
    const slow = gate();
    let firstItemStarted = false;

    const run = forEachWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      if (item === 0) {
        firstItemStarted = true;
        await slow.passed;
        return;
      }
      takenBySecondWorker.push(item);
    });

    await Promise.resolve();
    expect(firstItemStarted).toBe(true);
    slow.open();
    await run;

    expect(takenBySecondWorker).toEqual([1, 2, 3, 4, 5]);
  });

  it("runs strictly in series when asked for one at a time", async () => {
    const order: string[] = [];

    await forEachWithConcurrency([1, 2, 3], 1, async (item) => {
      order.push(`start-${item}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(`end-${item}`);
    });

    expect(order).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });

  it("does nothing, and does not hang, on an empty list", async () => {
    let called = false;
    await forEachWithConcurrency([], 4, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("rejects when the callback throws, as Promise.all would", async () => {
    await expect(
      forEachWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
  });

  it("defaults to a width the Drive downloader has already proven", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });

  it("accepts a Set as readily as an array", async () => {
    // Callers pass both: the audio ids a profile names are a Set.
    const seen: number[] = [];
    await forEachWithConcurrency(new Set([10, 20, 30]), 2, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });
});
