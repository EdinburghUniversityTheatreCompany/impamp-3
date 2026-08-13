import { describe, expect, it } from "vitest";
import { formatBytes, usedFraction } from "./format";

describe("formatBytes", () => {
  it("shows whole bytes without a decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("keeps one decimal below ten of a unit", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
  });

  it("drops the decimal above ten of a unit", () => {
    expect(formatBytes(14 * 1024 ** 3)).toBe("14 GB");
  });

  it("stops at terabytes rather than inventing a unit", () => {
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120 TB");
  });

  it("treats zero and nonsense as nothing", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});

describe("usedFraction", () => {
  it("is the plain ratio in range", () => {
    expect(usedFraction(50, 200)).toBe(0.25);
  });

  it("clamps past full, so an over-quota bar does not overflow", () => {
    expect(usedFraction(300, 200)).toBe(1);
  });

  it("is zero when there is no allowance to divide by", () => {
    expect(usedFraction(10, 0)).toBe(0);
  });
});
