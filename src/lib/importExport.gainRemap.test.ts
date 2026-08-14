import { describe, expect, it } from "vitest";
import { remapAudioFileIdKeys } from "./importExport";

describe("remapAudioFileIdKeys", () => {
  describe('unmappedKeys: "drop" (import + Google Drive sync-write paths)', () => {
    it("remaps keys that have a mapping", () => {
      const idMap = new Map<number, number>([
        [10, 100],
        [11, 101],
      ]);
      const settings = { 10: 3.5, 11: -2 };

      const result = remapAudioFileIdKeys(settings, idMap, "drop");

      expect(result).toEqual({ 100: 3.5, 101: -2 });
    });

    it("drops keys that have no mapping", () => {
      const idMap = new Map<number, number>([[10, 100]]);
      const settings = { 10: 3.5, 999: -2 };

      const result = remapAudioFileIdKeys(settings, idMap, "drop");

      expect(result).toEqual({ 100: 3.5 });
      expect(result).not.toHaveProperty("999");
    });

    it("returns undefined when passed undefined", () => {
      const idMap = new Map<number, number>([[10, 100]]);

      const result = remapAudioFileIdKeys(undefined, idMap, "drop");

      expect(result).toBeUndefined();
    });

    it("returns an empty object when nothing maps", () => {
      const idMap = new Map<number, number>();
      const settings = { 10: 3.5 };

      const result = remapAudioFileIdKeys(settings, idMap, "drop");

      expect(result).toEqual({});
    });
  });

  describe('unmappedKeys: "keep" (sync-merge path)', () => {
    it("remaps keys that have a mapping", () => {
      const idMap = new Map<number, number>([
        [10, 100],
        [11, 101],
      ]);
      const settings = { 10: 3.5, 11: -2 };

      const result = remapAudioFileIdKeys(settings, idMap, "keep");

      expect(result).toEqual({ 100: 3.5, 101: -2 });
    });

    it("keeps a key that has no mapping under its original id", () => {
      const idMap = new Map<number, number>([[10, 100]]);
      const settings = { 10: 3.5, 999: -2 };

      const result = remapAudioFileIdKeys(settings, idMap, "keep");

      expect(result).toEqual({ 100: 3.5, 999: -2 });
    });

    it("returns undefined when passed undefined", () => {
      const idMap = new Map<number, number>([[10, 100]]);

      const result = remapAudioFileIdKeys(undefined, idMap, "keep");

      expect(result).toBeUndefined();
    });

    it("keeps everything under original ids when nothing maps", () => {
      const idMap = new Map<number, number>();
      const settings = { 10: 3.5, 11: -2 };

      const result = remapAudioFileIdKeys(settings, idMap, "keep");

      expect(result).toEqual({ 10: 3.5, 11: -2 });
    });

    it("self-mapping (old id === new id) behaves the same as no mapping at all", () => {
      // This is the one case where the old `map.get(id) ?? id` fallback and
      // the current `newId !== undefined` branch could have diverged: both
      // read as "the value maps to itself", but they reach that outcome via
      // different code paths (an explicit hit vs. falling through to the
      // `?? id` default). Pin that they still agree.
      const idMap = new Map<number, number>([[10, 10]]);
      const settings = { 10: 3.5 };

      const result = remapAudioFileIdKeys(settings, idMap, "keep");

      expect(result).toEqual({ 10: 3.5 });
    });
  });

  it("the two modes diverge on the exact case that matters: an unmapped key", () => {
    const idMap = new Map<number, number>();
    const settings = { 42: 7 };

    const dropped = remapAudioFileIdKeys(settings, idMap, "drop");
    const kept = remapAudioFileIdKeys(settings, idMap, "keep");

    expect(dropped).toEqual({});
    expect(kept).toEqual({ 42: 7 });
  });
});
