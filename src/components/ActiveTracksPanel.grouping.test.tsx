// @vitest-environment jsdom
/**
 * `ActiveTracksPanel` used to render one `active-track-item` per entry in
 * `activePlayback`. Now that the map is keyed by instance key, several
 * entries can belong to the same pad, and the panel must fold them into one
 * row per pad via `groupPlaybackByPad` — a bare "one row per map entry"
 * rendering would still compile and would still pass a test built with only
 * one instance per pad, so every assertion here constructs at least two
 * instances of the same pad with `makeInstanceKey`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeInstanceKey } from "@/lib/audio/types";
import { usePlaybackStore, type PlaybackState } from "@/store/playbackStore";
import ActiveTracksPanel from "./ActiveTracksPanel";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function track(
  key: string,
  name: string,
  over: Partial<PlaybackState> = {},
): PlaybackState {
  return {
    key,
    name,
    progress: 0.5,
    remainingTime: 5,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: 1, bankId: "0", padIndex: 3 },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  usePlaybackStore.setState({ activePlayback: new Map() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  usePlaybackStore.setState({ activePlayback: new Map() });
});

describe("ActiveTracksPanel", () => {
  it("shows 'Nothing playing' with an empty store", () => {
    act(() => {
      root.render(<ActiveTracksPanel />);
    });
    expect(container.textContent).toContain("Nothing playing");
    expect(
      container.querySelectorAll('[data-testid="active-track-item"]'),
    ).toHaveLength(0);
  });

  it("renders one row for one pad with one instance (today's real case)", () => {
    const { actions } = usePlaybackStore.getState();
    actions.addTrack("pad-1-0-3", track("pad-1-0-3", "Applause"));

    act(() => {
      root.render(<ActiveTracksPanel />);
    });

    expect(
      container.querySelectorAll('[data-testid="active-track-item"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("Applause");
    expect(
      container.querySelector('[data-testid="active-track-layer-count"]'),
    ).toBeNull();
  });

  it("folds several instances of one pad into a single row, alongside a separate pad's own row", () => {
    const { actions } = usePlaybackStore.getState();
    const base = "pad-1-0-3";
    actions.addTrack(base, track(base, "Applause"));
    actions.addTrack(
      makeInstanceKey(base, 1),
      track(makeInstanceKey(base, 1), "Applause"),
    );
    actions.addTrack(
      makeInstanceKey(base, 2),
      track(makeInstanceKey(base, 2), "Applause"),
    );
    actions.addTrack("pad-1-0-4", track("pad-1-0-4", "Rain loop"));

    act(() => {
      root.render(<ActiveTracksPanel />);
    });

    // Four instances went in, but only two pads — a per-entry rendering
    // would show four rows here, not two.
    const rows = container.querySelectorAll(
      '[data-testid="active-track-item"]',
    );
    expect(rows).toHaveLength(2);

    const countButton = container.querySelector(
      '[data-testid="active-track-layer-count"]',
    );
    expect(countButton).not.toBeNull();
    expect(countButton!.textContent).toBe("x3");

    // The unstacked pad's row carries no count button.
    const rainRow = Array.from(rows).find((r) =>
      r.textContent?.includes("Rain loop"),
    )!;
    expect(
      rainRow.querySelector('[data-testid="active-track-layer-count"]'),
    ).toBeNull();
  });
});
