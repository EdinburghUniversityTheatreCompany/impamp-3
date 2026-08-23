/**
 * Which browsers count as able to do Web Audio.
 *
 * The one case that matters is the prefixed constructor. `getAudioContext`
 * has always fallen back to `window.webkitAudioContext`, and the guard added
 * to `startBackgroundAnalysis` asked `typeof AudioContext` instead — so on
 * such a browser playback worked and no file was ever analysed, which is
 * silent: everything simply plays un-normalised at 0 dB forever.
 *
 * Both cases below fail against a bare `typeof AudioContext` check, which is
 * the mutation they exist to catch.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getAudioContextConstructor, hasWebAudio } from "./capability";

type MaybeWindow = { window?: unknown };

afterEach(() => {
  delete (globalThis as MaybeWindow).window;
});

/** Installs a `window` carrying exactly the constructors named. */
function windowWith(props: Record<string, unknown>): void {
  (globalThis as MaybeWindow).window = props;
}

class FakeAudioContext {}

describe("Web Audio capability", () => {
  it("accepts a browser carrying only the prefixed constructor", () => {
    windowWith({ webkitAudioContext: FakeAudioContext });

    expect(hasWebAudio()).toBe(true);
    expect(getAudioContextConstructor()).toBe(FakeAudioContext);
  });

  it("accepts the unprefixed constructor, and prefers it", () => {
    class Standard {}
    windowWith({
      AudioContext: Standard,
      webkitAudioContext: FakeAudioContext,
    });

    expect(hasWebAudio()).toBe(true);
    expect(getAudioContextConstructor()).toBe(Standard);
  });

  it("refuses a browser carrying neither", () => {
    windowWith({});

    expect(hasWebAudio()).toBe(false);
    expect(getAudioContextConstructor()).toBeUndefined();
  });

  it("refuses the server, where there is no window at all", () => {
    expect(hasWebAudio()).toBe(false);
    expect(getAudioContextConstructor()).toBeUndefined();
  });
});
