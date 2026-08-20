/**
 * The two playback races the whole-repo review found (🔴 P1, P2).
 *
 * Both are about a *pending* trigger colliding with something else: a second
 * trigger for the same pad, or a stop of a different pad. They are unit-testable
 * because the only Web Audio the playback module touches is `getAudioContext`,
 * so a fake context that records `stop()` calls is enough to observe whether a
 * source was really silenced or merely forgotten about. That fake is shared
 * with `playback.layers.test.ts`; see `@/lib/testSupport/fakeWebAudio`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createdSources,
  fakeAudioBuffer,
  fakeAudioContext,
  fakePlayParams,
  resetFakeWebAudio,
  stubAnimationFrame,
} from "@/lib/testSupport/fakeWebAudio";

vi.mock("./context", () => ({
  getAudioContext: () => fakeAudioContext,
}));

// The rAF progress loop is irrelevant here; keep it from throwing in node.
stubAnimationFrame();

const {
  playBuffer,
  stopTrack,
  stopAllTracks,
  getStopGeneration,
  stopRequestedSince,
  isTrackPlaying,
} = await import("./playback");

function play(key: string) {
  return playBuffer(fakeAudioBuffer, key, fakePlayParams(key));
}

beforeEach(() => {
  stopAllTracks();
  resetFakeWebAudio();
});

describe("a second trigger for a pad that is already playing", () => {
  it("silences the source it displaces instead of orphaning it", () => {
    // Two triggers for one pad both got past the "is it playing?" check while
    // their blob reads were in flight, so both reach playBuffer.
    play("pad-1");
    play("pad-1");

    const [first, second] = createdSources;
    expect(createdSources).toHaveLength(2);

    // Without the fix the first source is evicted from the track map and keeps
    // playing, audible and unreachable.
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
  });

  it("leaves a displaced source stoppable by the panic button", () => {
    play("pad-1");
    const [first] = createdSources;
    play("pad-1");

    stopAllTracks();

    // stopAllTracks iterates the track map, so a source that was dropped from
    // it can only be silenced if the displacement itself stopped it.
    expect(first.stopped).toBe(true);
    expect(isTrackPlaying("pad-1")).toBe(false);
  });
});

describe("stop generations are per playback key", () => {
  it("does not cancel another pad's pending trigger", () => {
    play("pad-a");
    play("pad-b");

    // A trigger for pad-a captures its generation, then something stops pad-b
    // while pad-a's audio is still loading.
    const captured = getStopGeneration("pad-a");
    stopTrack("pad-b");

    expect(stopRequestedSince("pad-a", captured)).toBe(false);
  });

  it("still cancels a pending trigger for the pad that was stopped", () => {
    play("pad-a");

    const captured = getStopGeneration("pad-a");
    stopTrack("pad-a");

    expect(stopRequestedSince("pad-a", captured)).toBe(true);
  });

  it("cancels every pending trigger when everything is stopped", () => {
    play("pad-a");
    play("pad-b");

    const capturedA = getStopGeneration("pad-a");
    const capturedB = getStopGeneration("pad-b");
    stopAllTracks();

    // ESC must reach triggers that have not registered a track yet, whichever
    // pad they belong to.
    expect(stopRequestedSince("pad-a", capturedA)).toBe(true);
    expect(stopRequestedSince("pad-b", capturedB)).toBe(true);
  });

  it("cancels a pending trigger for a pad that is not playing yet", () => {
    // The trigger captured its generation before anything was in the map, which
    // is exactly the window ESC has to be able to reach.
    const captured = getStopGeneration("pad-c");
    stopAllTracks();

    expect(stopRequestedSince("pad-c", captured)).toBe(true);
  });
});
