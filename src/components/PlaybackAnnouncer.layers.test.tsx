// @vitest-environment jsdom
/**
 * The live region used to join every entry's name with a comma. Now that
 * `activePlayback` is keyed by instance key, a stacked pad's several layers
 * all carry the same name, and a plain join would read "Applause, Applause,
 * Applause" — which is why the announcer must fold through
 * `groupPlaybackByPad`/`describePlayingLayers` and say the count once
 * instead. The fixture below builds three instances of one pad by hand with
 * `makeInstanceKey`; with only one instance the old join and the new fold
 * produce the same sentence and the test would prove nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeInstanceKey } from "@/lib/audio/types";
import { usePlaybackStore, type PlaybackState } from "@/store/playbackStore";
import PlaybackAnnouncer from "./PlaybackAnnouncer";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function track(key: string, name: string): PlaybackState {
  return {
    key,
    name,
    progress: 0.5,
    remainingTime: 5,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: 1, bankId: "0", padIndex: 3 },
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

function announcerText(): string | null {
  return (
    container.querySelector('[data-testid="playback-announcer"]')
      ?.textContent ?? null
  );
}

describe("PlaybackAnnouncer", () => {
  it("says 'Playback stopped' with nothing playing", () => {
    act(() => {
      root.render(<PlaybackAnnouncer />);
    });
    expect(announcerText()).toBe("Playback stopped");
  });

  it("announces a single pad by name (today's real case)", () => {
    usePlaybackStore
      .getState()
      .actions.addTrack("pad-1-0-3", track("pad-1-0-3", "Applause"));

    act(() => {
      root.render(<PlaybackAnnouncer />);
    });

    expect(announcerText()).toBe("Playing: Applause");
  });

  it("announces the layer count once, not the name three times", () => {
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

    act(() => {
      root.render(<PlaybackAnnouncer />);
    });

    expect(announcerText()).toBe("Playing: Applause, 3 layers");
    expect(announcerText()).not.toBe("Playing: Applause, Applause, Applause");
  });
});
