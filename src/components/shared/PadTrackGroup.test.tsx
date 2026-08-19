// @vitest-environment jsdom
/**
 * `PadTrackGroup` renders one Active Tracks row per pad. A pad with one sound
 * must look exactly as it did before layers existed — no count button. A pad
 * with several must show the count button, keep the layer rows collapsed
 * until pressed, and stop each layer independently once expanded.
 *
 * Nothing mints an instance key yet (that lands in a later task), so every
 * fixture here builds its multi-layer groups by hand with `makeInstanceKey` —
 * a fixture with one instance per pad cannot tell grouped-by-pad rendering
 * apart from the old one-row-per-key rendering.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeInstanceKey } from "@/lib/audio/types";
import type { PadPlaybackGroup, PlaybackState } from "@/store/playbackStore";
import PadTrackGroup from "./PadTrackGroup";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function layer(key: string, over: Partial<PlaybackState> = {}): PlaybackState {
  return {
    key,
    name: "Applause",
    progress: 0.5,
    remainingTime: 5,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: 1, bankId: "0", padIndex: 3 },
    ...over,
  };
}

function groupOf(...layers: PlaybackState[]): PadPlaybackGroup {
  return {
    baseKey: "pad-1-0-3",
    name: layers[0].name,
    layers,
    newest: layers[layers.length - 1],
    isFading: layers.every((l) => l.isFading),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PadTrackGroup with a single layer (today's real case)", () => {
  it("renders one active-track-item and no count button", () => {
    const group = groupOf(layer("pad-1-0-3"));
    act(() => {
      root.render(<PadTrackGroup group={group} />);
    });

    expect(
      container.querySelectorAll('[data-testid="active-track-item"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="active-track-layer-count"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="active-track-layer-item"]'),
    ).toBeNull();
  });
});

describe("PadTrackGroup with several layers", () => {
  it("shows a count button and keeps layers collapsed until pressed", () => {
    const group = groupOf(
      layer("pad-1-0-3"),
      layer(makeInstanceKey("pad-1-0-3", 1)),
      layer(makeInstanceKey("pad-1-0-3", 2)),
    );
    act(() => {
      root.render(<PadTrackGroup group={group} />);
    });

    // Exactly one grouped row, not one per layer.
    expect(
      container.querySelectorAll('[data-testid="active-track-item"]'),
    ).toHaveLength(1);

    const countButton = container.querySelector(
      '[data-testid="active-track-layer-count"]',
    );
    expect(countButton).not.toBeNull();
    expect(countButton!.textContent).toBe("x3");
    expect(countButton!.getAttribute("aria-expanded")).toBe("false");

    // Collapsed: no layer rows yet.
    expect(
      container.querySelectorAll('[data-testid="active-track-layer-item"]'),
    ).toHaveLength(0);

    click(countButton!);

    expect(countButton!.getAttribute("aria-expanded")).toBe("true");
    const layerRows = container.querySelectorAll(
      '[data-testid="active-track-layer-item"]',
    );
    expect(layerRows).toHaveLength(3);

    click(countButton!);
    expect(
      container.querySelectorAll('[data-testid="active-track-layer-item"]'),
    ).toHaveLength(0);
  });

  it("stops the click from bubbling past the count button", () => {
    // `TrackItem` (the group row) is a sibling of the count button in the
    // DOM, not an ancestor, so a click on the button was never going to
    // reach TrackItem's own onClick by bubbling through it — that path is
    // structurally closed regardless of this test. What `stopPropagation`
    // actually guards is bubbling *past* the button, to whatever wraps this
    // component (a card, a list row, a future click-to-select container).
    // A first draft of this test attached its listener directly to the node
    // passed to `createRoot`. React delegates its own event handling to that
    // exact node, so a descendant's `stopPropagation()` — which stops the
    // *native* event from bubbling past the point React captured it — still
    // left that node's own listener firing: a node's own listeners all run
    // regardless of what a descendant's handler does, since propagation
    // control only affects whether *further* ancestors are reached. That
    // assertion could not fail no matter what the component did. This
    // version puts a real DOM ancestor *outside* the React root between the
    // button and the listener, so the native event has to cross it.
    let outerClicks = 0;
    const outer = document.createElement("div");
    outer.addEventListener("click", () => {
      outerClicks += 1;
    });
    const reactRootNode = document.createElement("div");
    outer.appendChild(reactRootNode);
    container.appendChild(outer);
    const outerRoot = createRoot(reactRootNode);

    const group = groupOf(
      layer("pad-1-0-3"),
      layer(makeInstanceKey("pad-1-0-3", 1)),
    );
    act(() => {
      outerRoot.render(<PadTrackGroup group={group} />);
    });

    const countButton = outer.querySelector(
      '[data-testid="active-track-layer-count"]',
    )!;
    click(countButton);

    expect(outerClicks).toBe(0);
    expect(countButton.getAttribute("aria-expanded")).toBe("true");

    // Sanity check that this harness does detect a bubbled click at all:
    // clicking the group row itself (which does not stop propagation)
    // must reach the same outer listener.
    const groupRow = outer.querySelector('[data-testid="active-track-item"]')!;
    click(groupRow);
    expect(outerClicks).toBe(1);

    act(() => {
      outerRoot.unmount();
    });
  });

  it("labels each layer row and follows the newest layer's time on the group row", () => {
    const group = groupOf(
      layer("pad-1-0-3", { remainingTime: 2, progress: 0.8 }),
      layer(makeInstanceKey("pad-1-0-3", 1), {
        remainingTime: 9,
        progress: 0.1,
      }),
    );
    act(() => {
      root.render(<PadTrackGroup group={group} />);
    });

    // The visible (collapsed) group row shows the newest layer's remaining
    // time, not the oldest's — the two layers here deliberately differ so a
    // selector that picked the wrong one, or the first one, would be caught.
    const groupRow = container.querySelector(
      '[data-testid="active-track-item"]',
    )!;
    expect(groupRow.textContent).toContain("0:09");
    expect(groupRow.textContent).not.toContain("0:02");

    const countButton = container.querySelector(
      '[data-testid="active-track-layer-count"]',
    )!;
    click(countButton);

    const layerRows = Array.from(
      container.querySelectorAll('[data-testid="active-track-layer-item"]'),
    );
    expect(layerRows.map((r) => r.textContent?.includes("layer 1"))).toEqual([
      true,
      false,
    ]);
    expect(layerRows.map((r) => r.textContent?.includes("layer 2"))).toEqual([
      false,
      true,
    ]);
    // Oldest layer keeps its own (older) remaining time in its own row.
    expect(layerRows[0].textContent).toContain("0:02");
    expect(layerRows[1].textContent).toContain("0:09");
  });
});
