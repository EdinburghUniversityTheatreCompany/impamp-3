// @vitest-environment jsdom
/**
 * What the search modal hands the trigger and the armed queue.
 *
 * Clicking a result plays it; the arm chord queues it. Both used to build
 * their payload by hand out of a `SearchResult` — a `TriggerablePad` in one
 * case, an `ArmedTrackState` in the other — so every playback field the pad
 * carries was named twice more here, in two literals that no compiler check
 * tied to each other or to `SearchResult`, and omitting an optional field
 * from either was silently legal. Both now spread
 * `extractPadPlaybackSettings(result)`; these cases assert from the outside
 * that the fields still arrive.
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
  isStale: false,
  resultsTerm: "horn",
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
    isStale: mocks.isStale,
    resultsTerm: mocks.resultsTerm,
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
  mocks.isStale = false;
  mocks.resultsTerm = "horn";
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

describe("keys on a result button", () => {
  /** Renders the open modal over one result and presses a key on it. */
  function pressOnResult(
    key: string,
    chord: { ctrlKey?: boolean } = {},
  ): KeyboardEvent {
    mocks.results = [searchResult({ name: "Horn" })];
    act(() => {
      root.render(<SearchModal isOpen onClose={() => {}} />);
    });
    const item = container.querySelector<HTMLButtonElement>(
      '[data-testid="search-result-item"]',
    )!;
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...chord,
    });
    act(() => {
      item.dispatchEvent(event);
    });
    return event;
  }

  it("arms on the chord", () => {
    pressOnResult("Enter", { ctrlKey: true });
    expect(mocks.armTrack).toHaveBeenCalledTimes(1);
  });

  it("ignores an ordinary character, chord or not", () => {
    // `handleResultKeyDown`'s `e.key !== "Enter"` half, which could be deleted
    // with all 1544 tests green — every key test in this file pressed Enter,
    // so a focused result would have armed on any keystroke.
    const plain = pressOnResult("x");
    expect(mocks.armTrack).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);

    const chorded = pressOnResult("x", { ctrlKey: true });
    expect(mocks.armTrack).not.toHaveBeenCalled();
    expect(chorded.defaultPrevented).toBe(false);
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

/**
 * The keyboard route from Ctrl+F to a cue.
 *
 * The arm chord lived only on the result `<button>`, and the input keeps
 * focus after typing — so arming meant typing, tabbing past whatever lay
 * between, then holding the chord. Plain Enter in the input did nothing at
 * all, because nothing activated the first result. During a show the fastest
 * path has to be type, Enter or chord-Enter, and no Tab anywhere in it.
 */
describe("activating the first result from the input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Opens the modal over `results` and returns the input the modal itself
   * focused — not one this test focused for it, which would assume away half
   * of what is being claimed.
   */
  function focusedInput(results: SearchResult[]): HTMLInputElement {
    mocks.results = results;
    act(() => {
      root.render(<SearchModal isOpen onClose={() => {}} />);
    });
    // The modal focuses the input on a 100 ms timer.
    act(() => {
      vi.advanceTimersByTime(150);
    });

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="search-input"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    return input!;
  }

  /** Presses Enter on the element, with or without the arm chord. */
  function pressKey(
    on: HTMLElement,
    key: string,
    chord: { ctrlKey?: boolean; metaKey?: boolean } = {},
  ): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...chord,
    });
    act(() => {
      on.dispatchEvent(event);
    });
    return event;
  }

  it("plays the first result on a plain Enter", () => {
    const input = focusedInput([
      searchResult({ name: "Horn" }),
      searchResult({ name: "Stab", padIndex: 4 }),
    ]);

    pressKey(input, "Enter");

    expect(mocks.triggerPad).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({ padIndex: 3 });
    expect(mocks.armTrack).not.toHaveBeenCalled();
  });

  it("arms the first result on Ctrl+Enter, and on Cmd+Enter", () => {
    // Both, because macOS claims Ctrl+click as the secondary click, so the
    // chord is read through `hasArmModifier` rather than `ctrlKey`. A handler
    // testing `ctrlKey` directly passes the first half of this and fails the
    // second.
    pressKey(focusedInput([searchResult()]), "Enter", { ctrlKey: true });
    expect(mocks.armTrack).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPad).not.toHaveBeenCalled();

    act(() => root.render(<SearchModal isOpen={false} onClose={() => {}} />));
    pressKey(focusedInput([searchResult()]), "Enter", { metaKey: true });
    expect(mocks.armTrack).toHaveBeenCalledTimes(2);
    expect(mocks.triggerPad).not.toHaveBeenCalled();
  });

  it("ignores an ordinary character, rather than firing a cue per keystroke", () => {
    // The `e.key !== "Enter"` guard, which could be deleted with all 1544
    // tests green: every existing key test hard-codes Enter, so nothing had
    // ever sent this component another key. Without the guard, typing "a" into
    // the search box plays a sound — irreversibly, on a board used to run live
    // shows.
    const input = focusedInput([searchResult({ name: "Horn" })]);

    const event = pressKey(input, "a");

    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(mocks.armTrack).not.toHaveBeenCalled();
    // And it must not claim the key either: `useKeyboardListener` reads
    // `defaultPrevented` to know something nearer the target took the press.
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores an ordinary character even with the arm chord held", () => {
    const input = focusedInput([searchResult()]);

    const event = pressKey(input, "x", { ctrlKey: true });

    expect(mocks.armTrack).not.toHaveBeenCalled();
    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("claims the key it acted on, so no global shortcut acts on it too", () => {
    // `useKeyboardListener` returns early on `defaultPrevented` — that is the
    // whole of "a global shortcut must not act on a key something nearer the
    // target already claimed". Without it Enter would both activate a result
    // and fire an emergency cue.
    const event = pressKey(focusedInput([searchResult()]), "Enter");

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Enter alone when there is no result to activate", () => {
    // The other side of the same rule: claiming a key it did nothing with
    // would swallow the emergency cue whenever the search box was open and
    // empty.
    const event = pressKey(focusedInput([]), "Enter");

    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(mocks.armTrack).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("refuses a disabled first result the way a click on it would", () => {
    const event = pressKey(
      focusedInput([searchResult({ isDisabled: true })]),
      "Enter",
    );

    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(mocks.armTrack).not.toHaveBeenCalled();
    // Still claimed: the modal consumed the press, it simply had nothing to do
    // with it.
    expect(event.defaultPrevented).toBe(true);
  });

  it("says why a disabled first result did nothing", () => {
    // The press is consumed either way — it has to be, or it fires an
    // emergency cue from behind the modal — so silence here is a key that
    // vanishes: nothing plays, nothing is said, and the header a line above
    // has just promised that Enter plays the first result.
    pressKey(
      focusedInput([searchResult({ name: "Foghorn", isDisabled: true })]),
      "Enter",
    );

    const notice = container.querySelector(
      '[data-testid="search-activation-notice"]',
    );
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("role")).toBe("alert");
    expect(notice!.textContent).toContain("Foghorn");
    expect(notice!.textContent).toContain("disabled");
  });

  it("says so in the results header, in the platform's own words", () => {
    focusedInput([searchResult()]);

    const hint = container.querySelector(
      '[data-testid="search-activation-hint"]',
    );
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("Enter");
    // Not an Apple platform under jsdom, so the label is the Ctrl one.
    expect(hint!.textContent).toContain("Ctrl+Enter");
  });
});

/**
 * Enter, while the results on screen are the previous query's.
 *
 * `useSearch` debounces by 300 ms and keeps the old results up meanwhile —
 * `isLoading` is false for all of it — so "type, then Enter without moving
 * focus", the flow the input handler exists for, fired a cue from the query
 * the operator had just replaced. A cue is irreversible during a show, so the
 * handler refuses rather than guesses.
 */
describe("Enter while the results are from an earlier term", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openOver(results: SearchResult[]): HTMLInputElement {
    mocks.results = results;
    act(() => {
      root.render(<SearchModal isOpen onClose={() => {}} />);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    return container.querySelector<HTMLInputElement>(
      '[data-testid="search-input"]',
    )!;
  }

  function pressEnter(on: HTMLElement): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      on.dispatchEvent(event);
    });
    return event;
  }

  it("fires nothing at all", () => {
    mocks.isStale = true;
    const event = pressEnter(openOver([searchResult({ name: "Horn" })]));

    expect(mocks.triggerPad).not.toHaveBeenCalled();
    expect(mocks.armTrack).not.toHaveBeenCalled();
    // Claimed even so: there is a result on screen and a hint saying Enter
    // plays it, so letting the press through to the global handler would fire
    // an emergency cue from behind an open modal.
    expect(event.defaultPrevented).toBe(true);
  });

  it("says why, naming the term the results do answer", () => {
    mocks.isStale = true;
    mocks.resultsTerm = "horn";
    pressEnter(openOver([searchResult()]));

    const notice = container.querySelector(
      '[data-testid="search-activation-notice"]',
    );
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("role")).toBe("alert");
    expect(notice!.textContent).toContain("horn");
  });

  it("stops promising that Enter plays the first result", () => {
    // The hint is the whole reason an operator presses Enter without looking.
    mocks.isStale = true;
    openOver([searchResult()]);

    const hint = container.querySelector(
      '[data-testid="search-activation-hint"]',
    );
    expect(hint!.textContent).not.toContain("Enter plays");
  });

  it("acts normally once the results have caught up", () => {
    mocks.isStale = false;
    pressEnter(openOver([searchResult()]));

    expect(mocks.triggerPad).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="search-activation-notice"]'),
    ).toBeNull();
  });
});
