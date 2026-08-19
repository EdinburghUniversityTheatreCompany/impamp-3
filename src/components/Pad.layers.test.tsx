// @vitest-environment jsdom
/**
 * The pad's ring and remaining time must follow the newest layer, and the pad
 * must show a count badge only once it stacks. Both claims need at least two
 * layers with different remaining times built by hand with `makeInstanceKey`
 * — with a single instance, "the newest layer" and "the only layer" are the
 * same thing and a wrong selector could not be told apart from a correct one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePlaybackKey, makeInstanceKey } from "@/lib/audio/types";
import { usePlaybackStore, type PlaybackState } from "@/store/playbackStore";
import Pad from "./Pad";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ID = 1;
const BANK_ID = "0";
const PAD_INDEX = 3;
const BASE_KEY = generatePlaybackKey(PROFILE_ID, BANK_ID, PAD_INDEX);

function track(key: string, over: Partial<PlaybackState> = {}): PlaybackState {
  return {
    key,
    name: "Applause",
    progress: 0.5,
    remainingTime: 5,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: PROFILE_ID, bankId: BANK_ID, padIndex: PAD_INDEX },
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

function renderPad() {
  act(() => {
    root.render(
      <Pad
        id="pad-3"
        padIndex={PAD_INDEX}
        profileId={PROFILE_ID}
        bankId={BANK_ID}
        name="Applause"
        isConfigured={true}
        soundCount={1}
        isEditMode={false}
        onClick={() => {}}
        onShiftClick={() => {}}
        onDropAudio={async () => {}}
      />,
    );
  });
}

describe("Pad with one playing instance (today's real case)", () => {
  it("shows no layer-count badge", () => {
    usePlaybackStore.getState().actions.addTrack(BASE_KEY, track(BASE_KEY));
    renderPad();

    expect(
      container.querySelector('[data-testid="pad-layer-count"]'),
    ).toBeNull();
  });
});

describe("Pad stacked with several layers", () => {
  it("shows a badge with the layer count", () => {
    const { actions } = usePlaybackStore.getState();
    actions.addTrack(BASE_KEY, track(BASE_KEY));
    actions.addTrack(
      makeInstanceKey(BASE_KEY, 1),
      track(makeInstanceKey(BASE_KEY, 1)),
    );
    actions.addTrack(
      makeInstanceKey(BASE_KEY, 2),
      track(makeInstanceKey(BASE_KEY, 2)),
    );
    renderPad();

    const badge = container.querySelector('[data-testid="pad-layer-count"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("x3");
  });

  it("follows the newest layer's remaining time, not the oldest's", () => {
    const { actions } = usePlaybackStore.getState();
    actions.addTrack(BASE_KEY, track(BASE_KEY, { remainingTime: 2 }));
    actions.addTrack(
      makeInstanceKey(BASE_KEY, 1),
      track(makeInstanceKey(BASE_KEY, 1), { remainingTime: 9 }),
    );
    renderPad();

    // PadProgressBar prints the rounded remaining seconds as "9s".
    expect(container.textContent).toContain("9s");
    expect(container.textContent).not.toContain("2s");
  });

  it("drops the badge once the pad is back down to one layer", () => {
    const { actions } = usePlaybackStore.getState();
    actions.addTrack(BASE_KEY, track(BASE_KEY));
    actions.addTrack(
      makeInstanceKey(BASE_KEY, 1),
      track(makeInstanceKey(BASE_KEY, 1)),
    );
    renderPad();
    expect(
      container.querySelector('[data-testid="pad-layer-count"]'),
    ).not.toBeNull();

    act(() => {
      usePlaybackStore
        .getState()
        .actions.removeTrack(makeInstanceKey(BASE_KEY, 1));
    });

    expect(
      container.querySelector('[data-testid="pad-layer-count"]'),
    ).toBeNull();
  });
});
