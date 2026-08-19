/**
 * The base key / instance key split.
 *
 * A pad owns one base key. Each layer of that pad owns an instance key made
 * from the base key and a number. Every read of "is this pad live?" resolves
 * through the base key, so the two must never disagree about where the split
 * is.
 *
 * `bankId` is a string bank identity (it can be a UUID, which contains
 * hyphens), so at least one case below deliberately uses a UUID-shaped bank
 * id to prove the split does not rely on splitting on "-".
 */
import { describe, expect, it } from "vitest";
import {
  MAX_LAYERS_PER_PAD,
  baseKeyOf,
  generatePlaybackKey,
  layerIndexOf,
  makeInstanceKey,
} from "./types";

const base = generatePlaybackKey(1, "0", 3);

describe("instance keys", () => {
  it("builds an instance key from a base key and a number", () => {
    expect(makeInstanceKey(base, 2)).toBe("pad-1-0-3#2");
  });

  it("reads the base key back out of an instance key", () => {
    expect(baseKeyOf(makeInstanceKey(base, 7))).toBe(base);
  });

  it("treats a bare base key as its own instance key", () => {
    expect(baseKeyOf(base)).toBe(base);
    expect(layerIndexOf(base)).toBe(0);
  });

  it("reads the layer number back out of an instance key", () => {
    expect(layerIndexOf(makeInstanceKey(base, 11))).toBe(11);
  });

  it("distinguishes a bare base key from an explicit instance 0", () => {
    const instanceZero = makeInstanceKey(base, 0);
    // Both answer layer index 0, but they are not the same key: a bug that
    // made makeInstanceKey(base, 0) return the bare base key would still
    // pass a test that only checked layerIndexOf.
    expect(instanceZero).not.toBe(base);
    expect(instanceZero).toBe(`${base}#0`);
    expect(baseKeyOf(instanceZero)).toBe(base);
    expect(layerIndexOf(instanceZero)).toBe(0);
  });

  it("orders a bare base key before every numbered layer", () => {
    const keys = [makeInstanceKey(base, 2), base, makeInstanceKey(base, 1)];
    keys.sort((a, b) => layerIndexOf(a) - layerIndexOf(b));
    expect(keys).toEqual([
      base,
      makeInstanceKey(base, 1),
      makeInstanceKey(base, 2),
    ]);
  });

  it("splits at the first separator only", () => {
    expect(baseKeyOf("pad-1-0-3#4#5")).toBe("pad-1-0-3");
  });

  it("splits on the layer separator, not on hyphens, when the bank id is a UUID", () => {
    const uuidBase = generatePlaybackKey(
      2,
      "550e8400-e29b-41d4-a716-446655440000",
      5,
    );
    const instance = makeInstanceKey(uuidBase, 3);
    expect(instance).toBe("pad-2-550e8400-e29b-41d4-a716-446655440000-5#3");
    expect(baseKeyOf(instance)).toBe(uuidBase);
    expect(layerIndexOf(instance)).toBe(3);
  });

  it("caps a pad at 16 layers", () => {
    expect(MAX_LAYERS_PER_PAD).toBe(16);
  });
});
