import { afterEach, describe, expect, it, vi } from "vitest";
import { armModifierLabel, hasArmModifier, isApplePlatform } from "./platform";

describe("hasArmModifier", () => {
  it("accepts Control, for Windows and Linux", () => {
    expect(hasArmModifier({ ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("accepts Command, which is the only chord a Mac mouse can send", () => {
    // Control+click never reaches the page as a click on macOS: the OS claims
    // it as the secondary click. This assertion is the bug that started it.
    expect(hasArmModifier({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("accepts both held together", () => {
    expect(hasArmModifier({ ctrlKey: true, metaKey: true })).toBe(true);
  });

  it("is false for a plain click, which must still play the pad", () => {
    expect(hasArmModifier({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("isApplePlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognises a Mac", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(isApplePlatform()).toBe(true);
  });

  it("recognises an iPhone", () => {
    vi.stubGlobal("navigator", { platform: "iPhone" });
    expect(isApplePlatform()).toBe(true);
  });

  it("prefers userAgentData where the browser offers it", () => {
    vi.stubGlobal("navigator", {
      userAgentData: { platform: "macOS" },
      platform: "Win32",
    });
    expect(isApplePlatform()).toBe(true);
  });

  it("falls back to the user agent when there is no platform string", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    expect(isApplePlatform()).toBe(true);
  });

  it("says no on Windows", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(isApplePlatform()).toBe(false);
  });

  it("says no with no navigator at all, as on the server", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isApplePlatform()).toBe(false);
  });
});

describe("armModifierLabel", () => {
  it("writes the Command glyph on Apple platforms", () => {
    expect(armModifierLabel(true)).toBe("⌘");
  });

  it("writes Ctrl everywhere else", () => {
    expect(armModifierLabel(false)).toBe("Ctrl");
  });
});
