import { describe, expect, it } from "vitest";
import { formatGainDb, formatLufs, gainToneClass } from "./format";

describe("formatGainDb", () => {
  it("shows a sign for boost", () => {
    expect(formatGainDb(6)).toBe("+6.0");
  });

  it("shows a minus for cut", () => {
    expect(formatGainDb(-3.25)).toBe("−3.3");
  });

  it("shows unity without a sign", () => {
    expect(formatGainDb(0)).toBe("0.0");
  });
});

describe("gainToneClass", () => {
  it("de-emphasises unity", () => {
    expect(gainToneClass(0)).toContain("text-gray");
  });

  it("uses distinct classes for boost and cut", () => {
    expect(gainToneClass(3)).not.toBe(gainToneClass(-3));
  });

  // Colour must never be the only signal; the number is always rendered
  // alongside, so these classes are decoration rather than meaning.
  it("returns a class for every input", () => {
    for (const db of [-24, -1, 0, 1, 12]) {
      expect(typeof gainToneClass(db)).toBe("string");
    }
  });
});

describe("formatLufs", () => {
  it("renders a measurement to one decimal", () => {
    expect(formatLufs(-16.04)).toBe("−16.0");
  });

  it("renders an em dash for an unmeasurable value", () => {
    expect(formatLufs(null)).toBe("—");
  });
});
