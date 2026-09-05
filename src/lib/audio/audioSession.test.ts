// @vitest-environment jsdom
/**
 * The one line that decides whether an iPhone makes any sound at all.
 *
 * Safari's default audio session type is `"auto"`, which for a page that only
 * uses Web Audio resolves to `"ambient"` — and `"ambient"` is exactly the
 * category the hardware ringer switch silences. A board on a phone with the
 * switch flipped therefore plays every cue perfectly and inaudibly: the
 * context is running, the sources start and stop, the progress bars sweep,
 * and nothing comes out. Declaring `"playback"` is what moves the page onto
 * the media route the switch does not touch.
 *
 * The two failure arms are here because this sits on the trigger path. An
 * exception thrown while deciding *how* audio should be categorised would
 * cost the operator the cue itself, which is a far worse outcome than a
 * mis-categorised one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";

/** Installs an `audioSession` on the jsdom navigator, or removes it. */
function setNavigatorAudioSession(value: unknown): void {
  if (value === undefined) {
    delete (navigator as Navigator & { audioSession?: unknown }).audioSession;
    return;
  }
  Object.defineProperty(navigator, "audioSession", {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  setNavigatorAudioSession(undefined);
  vi.restoreAllMocks();
});

describe("configureAudioSessionForPlayback", () => {
  it("declares the page media playback so the ringer switch cannot silence it", async () => {
    const session = { type: "auto" };
    setNavigatorAudioSession(session);
    const { configureAudioSessionForPlayback } = await import("./audioSession");

    configureAudioSessionForPlayback();

    expect(session.type).toBe("playback");
  });

  it("does nothing on a browser without the Audio Session API", async () => {
    setNavigatorAudioSession(undefined);
    const { configureAudioSessionForPlayback } = await import("./audioSession");

    expect(() => configureAudioSessionForPlayback()).not.toThrow();
  });

  it("survives an implementation that refuses the assignment", async () => {
    quietConsole();
    setNavigatorAudioSession({
      set type(_value: string) {
        throw new TypeError("read only");
      },
      get type() {
        return "auto";
      },
    });
    const { configureAudioSessionForPlayback } = await import("./audioSession");

    expect(() => configureAudioSessionForPlayback()).not.toThrow();
  });
});
