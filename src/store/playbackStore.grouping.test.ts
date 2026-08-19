/**
 * Folding the instance-keyed store back into one row per pad.
 *
 * `activePlayback` is keyed by instance key, so a pad with three layers holds
 * three entries. Every consumer that shows a pad — the Active Tracks panel, the
 * live region and the pad itself — needs one answer per pad, and it needs the
 * newest layer for the ring and the remaining time.
 */
import { describe, expect, it } from "vitest";
import {
  describePlayingLayers,
  groupPlaybackByPad,
  type PlaybackState,
} from "./playbackStore";

function state(key: string, name: string, over: Partial<PlaybackState> = {}) {
  return {
    key,
    name,
    progress: 0,
    remainingTime: 10,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: 1, bankId: "0", padIndex: 3 },
    ...over,
  } as PlaybackState;
}

function mapOf(...states: PlaybackState[]) {
  return new Map(states.map((s) => [s.key, s]));
}

describe("groupPlaybackByPad", () => {
  it("gives one group per pad", () => {
    const groups = groupPlaybackByPad(
      mapOf(state("pad-1-0-3", "Applause"), state("pad-1-0-4", "Rain loop")),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.baseKey)).toEqual(["pad-1-0-3", "pad-1-0-4"]);
  });

  it("folds every layer of one pad into a single group", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
        state("pad-1-0-3#2", "Applause"),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].layers).toHaveLength(3);
    expect(groups[0].name).toBe("Applause");
  });

  it("orders the layers by layer number, oldest first", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3#2", "Applause"),
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
      ),
    );
    expect(groups[0].layers.map((l) => l.key)).toEqual([
      "pad-1-0-3",
      "pad-1-0-3#1",
      "pad-1-0-3#2",
    ]);
  });

  it("names the newest layer, which is what the pad ring follows", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { remainingTime: 2 }),
        state("pad-1-0-3#1", "Applause", { remainingTime: 9 }),
      ),
    );
    expect(groups[0].newest.key).toBe("pad-1-0-3#1");
    expect(groups[0].newest.remainingTime).toBe(9);
  });

  it("calls a group fading only when every layer fades", () => {
    const partly = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { isFading: true }),
        state("pad-1-0-3#1", "Applause"),
      ),
    );
    expect(partly[0].isFading).toBe(false);

    const wholly = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { isFading: true }),
        state("pad-1-0-3#1", "Applause", { isFading: true }),
      ),
    );
    expect(wholly[0].isFading).toBe(true);
  });
});

describe("describePlayingLayers", () => {
  it("says the name alone for a single layer", () => {
    const groups = groupPlaybackByPad(mapOf(state("pad-1-0-3", "Applause")));
    expect(describePlayingLayers(groups)).toBe("Applause");
  });

  it("counts the layers when a pad is stacked", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
        state("pad-1-0-3#2", "Applause"),
      ),
    );
    expect(describePlayingLayers(groups)).toBe("Applause, 3 layers");
  });

  it("joins several pads with a comma", () => {
    const groups = groupPlaybackByPad(
      mapOf(state("pad-1-0-3", "Applause"), state("pad-1-0-4", "Rain loop")),
    );
    expect(describePlayingLayers(groups)).toBe("Applause, Rain loop");
  });

  it("says nothing at all when nothing plays", () => {
    expect(describePlayingLayers(groupPlaybackByPad(new Map()))).toBe("");
  });
});
