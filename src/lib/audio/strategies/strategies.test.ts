/**
 * The three playback strategies, and the factory that hands them out.
 *
 * Two of the three carry state, and the state is the whole point: sequential
 * remembers where it stopped, round-robin remembers what it has not played
 * yet. That is why `getStrategy` keys them per pad — CLAUDE.md's "one cursor
 * per pad, never per layer" invariant is a property of this factory, and a
 * layered pad handed a fresh cursor per instance would replay its first sound
 * forever.
 *
 * Round-robin's contract is stronger than "not the same twice": across one
 * cycle every index must come out exactly once, which is what separates it
 * from random. Asserting that needs the whole cycle drained, not one draw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStrategy,
  RandomStrategy,
  RoundRobinStrategy,
  SequentialStrategy,
} from "./index";

/** Drains a whole round-robin cycle, returning the indices in draw order. */
function drainCycle(
  strategy: RoundRobinStrategy,
  audioFileIds: number[],
): number[] {
  return audioFileIds.map(() => {
    const { index } = strategy.selectNextSound(audioFileIds);
    strategy.updateState(index, audioFileIds);
    return index;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SequentialStrategy", () => {
  it("cycles back to the start after the last sound", () => {
    const strategy = new SequentialStrategy();
    const ids = [10, 20, 30];

    const drawn = ids.concat(ids).map(() => {
      const { audioFileId, index } = strategy.selectNextSound(ids);
      strategy.updateState(index, ids);
      return audioFileId;
    });

    expect(drawn).toEqual([10, 20, 30, 10, 20, 30]);
  });

  it("clamps an index left over from a longer list", () => {
    const strategy = new SequentialStrategy();
    const long = [1, 2, 3, 4];
    strategy.selectNextSound(long);
    strategy.updateState(3, long); // nextIndex is now 0 again
    strategy.updateState(2, long); // nextIndex is now 3

    // The pad now holds two sounds, so index 3 is out of bounds.
    expect(strategy.selectNextSound([7, 8])).toEqual({
      audioFileId: 7,
      index: 0,
    });
  });

  it("reset() sends the sequence back to the first sound", () => {
    const strategy = new SequentialStrategy();
    const ids = [1, 2, 3];
    strategy.selectNextSound(ids);
    strategy.updateState(0, ids);
    strategy.reset();

    expect(strategy.selectNextSound(ids).index).toBe(0);
  });

  it("refuses an empty pad rather than returning undefined", () => {
    expect(() => new SequentialStrategy().selectNextSound([])).toThrow(
      /empty array/,
    );
  });
});

describe("RandomStrategy", () => {
  it("indexes with the random draw and returns the matching id", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    expect(new RandomStrategy().selectNextSound([5, 6, 7])).toEqual({
      audioFileId: 7,
      index: 2,
    });
  });

  it("never runs off the end when random returns its supremum", () => {
    // Math.random() is [0, 1), but the floor has to hold for a value
    // arbitrarily close to 1 or the last draw indexes past the array.
    vi.spyOn(Math, "random").mockReturnValue(0.9999999999);

    const { index } = new RandomStrategy().selectNextSound([1, 2]);

    expect(index).toBe(1);
  });

  it("keeps no state, so updateState changes nothing", () => {
    const strategy = new RandomStrategy();
    vi.spyOn(Math, "random").mockReturnValue(0);

    strategy.updateState(0, [1, 2, 3]);

    expect(strategy.selectNextSound([1, 2, 3]).index).toBe(0);
  });

  it("refuses an empty pad rather than returning undefined", () => {
    expect(() => new RandomStrategy().selectNextSound([])).toThrow(
      /empty array/,
    );
  });
});

describe("RoundRobinStrategy", () => {
  it("plays every sound exactly once per cycle", () => {
    const ids = [11, 22, 33, 44];
    const drawn = drainCycle(new RoundRobinStrategy(), ids);

    expect([...drawn].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("starts a fresh cycle once the previous one is exhausted", () => {
    const strategy = new RoundRobinStrategy();
    const ids = [11, 22, 33];

    drainCycle(strategy, ids);
    const second = drainCycle(strategy, ids);

    expect([...second].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("rebuilds the cycle when the pad loses a sound mid-cycle", () => {
    const strategy = new RoundRobinStrategy();
    const four = [1, 2, 3, 4];
    strategy.selectNextSound(four);

    // Three indices are still pending, and at least one of them is >= 2.
    const { index } = strategy.selectNextSound([9, 8]);

    expect(index).toBeLessThan(2);
    expect(strategy.getAvailableIndices().every((i) => i < 2)).toBe(true);
  });

  it("updateState refills an exhausted cycle", () => {
    const strategy = new RoundRobinStrategy();
    const ids = [1, 2];
    strategy.selectNextSound(ids);
    strategy.selectNextSound(ids);
    expect(strategy.getAvailableIndices()).toEqual([]);

    strategy.updateState(1, ids);

    expect(strategy.getAvailableIndices()).toEqual([0, 1]);
  });

  it("getAvailableIndices hands back a copy, not the live array", () => {
    const strategy = new RoundRobinStrategy();
    strategy.selectNextSound([1, 2, 3]);

    strategy.getAvailableIndices().length = 0;

    expect(strategy.getAvailableIndices()).toHaveLength(2);
  });

  it("refuses an empty pad rather than returning undefined", () => {
    expect(() => new RoundRobinStrategy().selectNextSound([])).toThrow(
      /empty array/,
    );
  });
});

describe("getStrategy", () => {
  it("gives each pad its own sequential cursor", () => {
    const ids = [1, 2, 3];
    const padA = getStrategy("sequential", "bank-a-pad-0");
    const padB = getStrategy("sequential", "bank-a-pad-1");

    padA.selectNextSound(ids);
    padA.updateState(0, ids);

    expect(padA.selectNextSound(ids).index).toBe(1);
    expect(padB.selectNextSound(ids).index).toBe(0);
  });

  it("returns the same instance for the same key, so the cursor survives", () => {
    expect(getStrategy("round-robin", "same-key")).toBe(
      getStrategy("round-robin", "same-key"),
    );
    expect(getStrategy("round-robin", "other-key")).not.toBe(
      getStrategy("round-robin", "same-key"),
    );
  });

  it("gives each pad its own round-robin cycle", () => {
    const ids = [1, 2];
    const padA = getStrategy("round-robin", "rr-pad-a") as RoundRobinStrategy;
    const padB = getStrategy("round-robin", "rr-pad-b") as RoundRobinStrategy;

    padA.selectNextSound(ids);

    expect(padA.getAvailableIndices()).toHaveLength(1);
    expect(padB.getAvailableIndices()).toHaveLength(0);
  });

  it("shares one stateless instance for random", () => {
    expect(getStrategy("random", "pad-a")).toBe(getStrategy("random", "pad-b"));
    expect(getStrategy("random")).toBeInstanceOf(RandomStrategy);
  });

  it("falls back to a shared sequential instance without a key", () => {
    expect(getStrategy("round-robin")).toBeInstanceOf(SequentialStrategy);
    expect(getStrategy("sequential")).toBe(getStrategy("round-robin"));
  });

  it("falls back to sequential for a playback type it does not know", () => {
    // An imported archive supplies playbackType unvalidated, so this is a
    // value the union says cannot happen and a `.iaz` file can still deliver.
    const strategy = getStrategy(
      "shuffle-backwards" as unknown as Parameters<typeof getStrategy>[0],
      "pad",
    );

    expect(strategy).toBeInstanceOf(SequentialStrategy);
  });
});
