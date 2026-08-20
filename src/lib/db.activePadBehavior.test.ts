/**
 * The per-pad override of the profile's activePadBehavior.
 *
 * Undefined means "follow the profile", so pads written before this field
 * existed keep behaving exactly as they did. The resolver is the only place
 * that rule is written down.
 */
import { describe, expect, it } from "vitest";
import { extractPadPlaybackSettings, resolveActivePadBehavior } from "./db";

describe("resolveActivePadBehavior", () => {
  it("follows the profile when the pad says nothing", () => {
    expect(resolveActivePadBehavior({}, "restart")).toBe("restart");
    expect(
      resolveActivePadBehavior({ activePadBehavior: undefined }, "stop"),
    ).toBe("stop");
  });

  it("lets the pad beat the profile", () => {
    expect(
      resolveActivePadBehavior({ activePadBehavior: "layer" }, "continue"),
    ).toBe("layer");
  });
});

describe("extractPadPlaybackSettings", () => {
  it("carries the override, so a pad swap and a duplicate keep it", () => {
    const settings = extractPadPlaybackSettings({
      audioFileIds: [1],
      activePadBehavior: "layer",
    });
    expect(settings.activePadBehavior).toBe("layer");
  });

  it("leaves the override undefined when the pad has none", () => {
    const settings = extractPadPlaybackSettings({ audioFileIds: [1] });
    expect(settings.activePadBehavior).toBeUndefined();
  });
});
