// @vitest-environment jsdom
/**
 * What a pad shows when its sound could not be played.
 *
 * The overlay had an `"error"` branch from the day it was written: a spinner
 * with the word "Error" under it, which nothing ever reached. A failed press
 * is not a slow one, so the state gets its own overlay — no spinner, a red
 * tint — and the reason rides on `title` for whoever hovers to ask.
 */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import Pad from "./Pad";

let panel: MountedPanel | null = null;

afterEach(async () => {
  await panel?.unmount();
  panel = null;
});

async function mountPad(
  over: Partial<React.ComponentProps<typeof Pad>>,
): Promise<MountedPanel> {
  panel = await mountPanel(
    <Pad
      id="pad-3"
      padIndex={3}
      profileId={1}
      bankId="0"
      name="Applause"
      soundCount={1}
      isEditMode={false}
      onClick={() => {}}
      onShiftClick={() => {}}
      onDropAudio={async () => {}}
      {...over}
    />,
  );
  return panel;
}

describe("Pad in the error loading state", () => {
  it("shows the failure overlay without a spinner", async () => {
    const pad = await mountPad({
      isLoading: true,
      loadingStatus: "error",
      loadingError: "Failed to load audio file ID: 10 for pad 3",
    });

    const overlay = pad.required("pad-load-error");
    expect(overlay.textContent).toContain("Could not play");
    expect(overlay.getAttribute("title")).toBe(
      "Failed to load audio file ID: 10 for pad 3",
    );
    expect(pad.container.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the spinner for a pad that is merely loading", async () => {
    const pad = await mountPad({ isLoading: true, loadingStatus: "loading" });

    expect(pad.testId("pad-load-error")).toBeNull();
    expect(pad.container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("shows neither once the state is cleared", async () => {
    const pad = await mountPad({ isLoading: false });

    expect(pad.testId("pad-load-error")).toBeNull();
    expect(pad.container.querySelector(".animate-spin")).toBeNull();
  });
});
