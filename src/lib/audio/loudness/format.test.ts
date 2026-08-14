import { describe, expect, it } from "vitest";
import {
  formatDbMagnitude,
  formatGainDb,
  formatLufs,
  gainToneClass,
} from "./format";

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

  // A non-finite gain must never render as "-NaN" or any other string that
  // reads as a plausible value — it renders as unity (0.0 dB), matching
  // what clampPlaybackGain resolves a non-finite requested gain to.
  it("renders NaN as unity rather than propagating it", () => {
    expect(formatGainDb(NaN)).toBe("0.0");
  });

  it("renders Infinity as unity rather than propagating it", () => {
    expect(formatGainDb(Infinity)).toBe("0.0");
    expect(formatGainDb(-Infinity)).toBe("0.0");
  });
});

describe("formatDbMagnitude", () => {
  it("renders a positive value with no sign", () => {
    expect(formatDbMagnitude(2.3)).toBe("2.3");
  });

  it("renders a negative value's magnitude with no sign", () => {
    expect(formatDbMagnitude(-2.3)).toBe("2.3");
  });

  it("rounds to one decimal", () => {
    expect(formatDbMagnitude(2.34)).toBe("2.3");
  });

  it("renders zero as 0.0", () => {
    expect(formatDbMagnitude(0)).toBe("0.0");
  });

  it("renders a non-finite value as 0.0 rather than propagating it", () => {
    expect(formatDbMagnitude(NaN)).toBe("0.0");
    expect(formatDbMagnitude(Infinity)).toBe("0.0");
    expect(formatDbMagnitude(-Infinity)).toBe("0.0");
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

  // The number and the colour must never disagree: formatGainDb renders a
  // non-finite gain as unity ("0.0"), so the colour must be the unity
  // (gray) class too, not the cut/blue class it would otherwise fall
  // through to (every comparison against NaN is false).
  it("treats NaN as unity, matching formatGainDb", () => {
    expect(gainToneClass(NaN)).toBe(gainToneClass(0));
  });

  it("treats Infinity as unity, matching formatGainDb", () => {
    expect(gainToneClass(Infinity)).toBe(gainToneClass(0));
    expect(gainToneClass(-Infinity)).toBe(gainToneClass(0));
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
