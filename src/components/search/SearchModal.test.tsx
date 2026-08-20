// @vitest-environment jsdom
/**
 * What the search modal hands the trigger and the armed queue.
 *
 * Clicking a result plays it; the arm chord queues it. Both build their
 * payload by hand out of a `SearchResult` — a `TriggerablePad` in one case, an
 * `ArmedTrackState` in the other — so every playback field the pad carries has
 * to be named twice more here, in two literals that no compiler check ties to
 * each other or to `SearchResult`. Omitting an optional field from either is
 * silently legal.
 *
 * The pad's own `activePadBehavior` override is the newest such field, and
 * this is the only gate that can tell whether the search path carries it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/hooks/useSearch";

const mocks = vi.hoisted(() => ({
  triggerPad: vi.fn(),
  ensureAudioContextActive: vi.fn(),
  armTrack: vi.fn(),
  results: [] as SearchResult[],
}));

vi.mock("@/lib/audio", () => ({
  triggerPad: mocks.triggerPad,
  ensureAudioContextActive: mocks.ensureAudioContextActive,
}));
vi.mock("@/store/playbackStore", () => ({
  playbackStoreActions: { armTrack: mocks.armTrack },
}));
vi.mock("@/hooks/useSearch", () => ({
  useSearch: () => ({
    searchTerm: "horn",
    setSearchTerm: vi.fn(),
    results: mocks.results,
    isLoading: false,
  }),
}));

import SearchModal from "./SearchModal";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function searchResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    profileId: 1,
    bankId: "0",
    pageIndex: 0,
    padIndex: 3,
    name: "Horn",
    audioFileIds: [10],
    playbackType: "sequential",
    padGainDb: -3,
    isDisabled: false,
    originalFileName: "horn.wav",
    bankName: "Bank 1",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Renders the open modal over one result and clicks it, with or without Ctrl. */
function clickTheResult(result: SearchResult, withCtrl: boolean) {
  mocks.results = [result];
  act(() => {
    root.render(<SearchModal isOpen onClose={() => {}} />);
  });

  const item = container.querySelector<HTMLButtonElement>(
    '[data-testid="search-result-item"]',
  );
  expect(item).not.toBeNull();

  act(() => {
    item!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: withCtrl }),
    );
  });
}

describe("playing a search result", () => {
  it("carries the pad's activePadBehavior override to the trigger", () => {
    clickTheResult(searchResult({ activePadBehavior: "layer" }), false);

    expect(mocks.triggerPad).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({
      activePadBehavior: "layer",
      // Beside it so a pass cannot mean "the literal carried nothing at all".
      padGainDb: -3,
      padIndex: 3,
    });
  });

  it("leaves a pad with no override following the profile", () => {
    clickTheResult(searchResult(), false);

    expect(mocks.triggerPad.mock.calls[0][0]).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
  });
});

describe("arming a search result", () => {
  it("carries the pad's activePadBehavior override into the cue", () => {
    clickTheResult(searchResult({ activePadBehavior: "layer" }), true);

    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(mocks.armTrack).toHaveBeenCalledTimes(1);
    expect(mocks.armTrack.mock.calls[0][1]).toMatchObject({
      activePadBehavior: "layer",
      padGainDb: -3,
    });
  });

  it("leaves a pad with no override following the profile", () => {
    clickTheResult(searchResult(), true);

    expect(mocks.armTrack.mock.calls[0][1]).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
  });
});
