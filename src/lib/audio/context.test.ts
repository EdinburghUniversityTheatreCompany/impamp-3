// @vitest-environment jsdom
/**
 * The AudioContext singleton, and the two ways it gets un-suspended.
 *
 * A browser starts the context suspended until a user gesture, and then
 * suspends it again on its own initiative — Safari and some Chrome builds move
 * it to `"interrupted"`, a state the TypeScript lib does not admit exists,
 * which is why the module compares against it through a cast. A board whose
 * context is interrupted looks completely normal and makes no sound, so the
 * `"interrupted"` arm is not a nicety: leaving it out is a silent show-stopper
 * on one browser family and invisible everywhere else.
 *
 * The listeners registered on first creation are the unattended half of that.
 * Nobody presses anything when a laptop comes back from sleep or the operator
 * tabs back to the board, so `visibilitychange` and `focus` have to do it.
 * They are registered exactly once, because `getAudioContext` is on the
 * trigger path and a listener per call would leak one per pad press.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quietConsole } from "@/lib/testSupport/quietConsole";

type ContextState = "running" | "suspended" | "closed" | "interrupted";

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state: ContextState = "suspended";
  /**
   * The audio session type as it stood the moment this context was built.
   *
   * Captured rather than read afterwards because the ordering is the whole
   * point: a declaration made after `new AudioContext()` is a different claim
   * from one made before it, and only a snapshot taken inside the constructor
   * can tell the two apart.
   */
  sessionTypeAtConstruction: string | undefined;
  resume = vi.fn(async () => {
    this.state = "running";
  });
  constructor() {
    this.sessionTypeAtConstruction = (
      navigator as Navigator & { audioSession?: { type: string } }
    ).audioSession?.type;
    FakeAudioContext.created.push(this);
  }
}

/**
 * Imports a fresh copy of the module with `window.AudioContext` in place.
 *
 * The module memoises its context in a module-level binding and latches
 * `isClient` as it evaluates, so a suite that wants a second context — or a
 * second chance at the "created once" branch — has to reset the registry
 * rather than call an exported reset that does not exist.
 *
 * `audioContextCtor` has no default on purpose: the one caller that wants
 * `window.AudioContext` absent passes `undefined`, and a defaulted parameter
 * would quietly hand it the standard constructor instead.
 *
 * @param audioContextCtor - What `new window.AudioContext()` should build
 * @returns The module's exports
 */
async function loadContextModule(
  audioContextCtor: unknown,
): Promise<typeof import("./context")> {
  vi.resetModules();
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value: audioContextCtor,
  });
  return import("./context");
}

beforeEach(() => {
  FakeAudioContext.created = [];
  quietConsole();
});

afterEach(() => {
  delete (navigator as Navigator & { audioSession?: unknown }).audioSession;
  vi.restoreAllMocks();
});

describe("getAudioContext", () => {
  it("creates the context once and hands the same one back", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);

    const first = getAudioContext();
    const second = getAudioContext();

    expect(first).toBe(second);
    expect(FakeAudioContext.created).toHaveLength(1);
  });

  it("falls back to webkitAudioContext when the standard one is absent", async () => {
    class WebkitContext extends FakeAudioContext {}
    Object.defineProperty(window, "webkitAudioContext", {
      configurable: true,
      writable: true,
      value: WebkitContext,
    });

    const { getAudioContext } = await loadContextModule(undefined);

    expect(getAudioContext()).toBeInstanceOf(WebkitContext);
  });

  it("resumes a context the browser left suspended", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);

    const context = getAudioContext() as unknown as FakeAudioContext;

    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("resumes a context Safari left interrupted", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.resume.mockClear();
    context.state = "interrupted";

    getAudioContext();

    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("leaves a running context alone", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.resume.mockClear();
    context.state = "running";

    getAudioContext();

    expect(context.resume).not.toHaveBeenCalled();
  });

  it("swallows a rejected automatic resume rather than failing the trigger", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockRejectedValueOnce(new Error("gesture required"));

    expect(() => getAudioContext()).not.toThrow();
    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to automatically resume"),
        expect.any(Error),
      );
    });
  });
});

describe("resumeAudioContext", () => {
  it("resolves without touching a running context", async () => {
    const { getAudioContext, resumeAudioContext } =
      await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "running";
    context.resume.mockClear();

    await expect(resumeAudioContext()).resolves.toBeUndefined();
    expect(context.resume).not.toHaveBeenCalled();
  });

  it("resumes a suspended context", async () => {
    const { getAudioContext, resumeAudioContext } =
      await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockClear();

    await resumeAudioContext();

    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed explicit resume, unlike the automatic one", async () => {
    // The caller is a user gesture handler, which is the one place that can
    // act on the failure — so this half must not swallow it.
    const { getAudioContext, resumeAudioContext } =
      await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    // Not `mockRejectedValueOnce`: `resumeAudioContext` goes through
    // `getAudioContext`, which sees the same suspended state and spends the
    // first rejection on its own swallowed attempt.
    context.resume.mockRejectedValue(new Error("still blocked"));

    await expect(resumeAudioContext()).rejects.toThrow("still blocked");
  });
});

describe("the listeners registered on first creation", () => {
  it("resumes when the tab becomes visible again", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockClear();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);

    document.dispatchEvent(new Event("visibilitychange"));

    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the tab is still hidden", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockClear();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    document.dispatchEvent(new Event("visibilitychange"));

    expect(context.resume).not.toHaveBeenCalled();
  });

  it("resumes when the window regains focus", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockClear();

    window.dispatchEvent(new Event("focus"));

    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it("registers once however many times the context is fetched", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const { getAudioContext } = await loadContextModule(FakeAudioContext);

    getAudioContext();
    getAudioContext();
    getAudioContext();

    expect(add.mock.calls.filter(([type]) => type === "focus")).toHaveLength(1);
  });

  it("swallows a rejected resume from a background event", async () => {
    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    const context = getAudioContext() as unknown as FakeAudioContext;
    context.state = "suspended";
    context.resume.mockRejectedValue(new Error("no gesture yet"));

    expect(() => window.dispatchEvent(new Event("focus"))).not.toThrow();
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());
  });
});

describe("the iOS audio session", () => {
  it("is declared playback before the context is constructed", async () => {
    // Ordering, not just the value: Safari picks the route as the context is
    // built, and `"auto"` resolves to `"ambient"` for a Web Audio page —
    // the one category the hardware ringer switch mutes. Declared late, the
    // first cue of a show is still silent.
    const session = { type: "auto" };
    Object.defineProperty(navigator, "audioSession", {
      configurable: true,
      writable: true,
      value: session,
    });

    const { getAudioContext } = await loadContextModule(FakeAudioContext);
    getAudioContext();

    expect(FakeAudioContext.created[0].sessionTypeAtConstruction).toBe(
      "playback",
    );
  });
});
