// @vitest-environment jsdom
/**
 * The trim overlay: the one place in the app where a number a user drags turns
 * straight into where a cue starts and stops.
 *
 * It was at 0% of lines, and four of its behaviours are the sort that go wrong
 * silently:
 *
 * **A trim end of zero means "the whole file".** That is what a sound that has
 * never been trimmed carries, and what a sound whose file was replaced by a
 * shorter one carries too. Opening the trimmer on either and reading the
 * stored number literally gives a zero-length cue.
 *
 * **The handles cannot cross.** A 50 ms floor separates them, enforced on both
 * drags; without it a drag past the other handle produces a negative-length
 * range that plays nothing at all.
 *
 * **Escape backs out of the trimmer and nothing else.** This overlay is
 * portalled on top of the pad editor, which has its own Escape handler. Before
 * the shared stack existed, Escape here closed the whole editor and threw away
 * every unsaved change on the pad — the name, the playback mode, the gains,
 * the sound order.
 *
 * **The preview stops.** A preview left running when the overlay closes is a
 * sound in the room with no visible way to stop it short of the panic button.
 *
 * The canvas drawing is exercised rather than asserted on: a recording 2D
 * context stands in for the one jsdom does not provide, so the draw runs (and
 * a throw in it fails these tests) without anyone pretending to check pixels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import { quietConsole } from "@/lib/testSupport/quietConsole";

const getAudioFile = vi.fn();
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getAudioFile: (...args: unknown[]) => getAudioFile(...args),
}));

const decodeAudioBlob = vi.fn();
vi.mock("@/lib/audio/decoder", () => ({
  decodeAudioBlob: (...args: unknown[]) => decodeAudioBlob(...args),
}));

const playBuffer = vi.fn();
const stopTrack = vi.fn();
vi.mock("@/lib/audio/playback", () => ({
  playBuffer: (...args: unknown[]) => playBuffer(...args),
  stopTrack: (...args: unknown[]) => stopTrack(...args),
}));

const getCachedLoudness = vi.fn();
let notifyLoudnessCache: (() => void) | null = null;
vi.mock("@/lib/audio/loudness/cache", () => ({
  getCachedLoudness: (...args: unknown[]) => getCachedLoudness(...args),
  subscribeToLoudnessCache: (listener: () => void) => {
    notifyLoudnessCache = listener;
    return () => {
      notifyLoudnessCache = null;
    };
  },
}));

const resolveGain = vi.fn();
vi.mock("@/lib/audio/loudness/gain", () => ({
  resolveGain: (...args: unknown[]) => resolveGain(...args),
}));

const WaveformTrimmer = (await import("./WaveformTrimmer")).default;

/** A gain resolution with nothing to complain about. */
const measuredGain = {
  linear: 0.5,
  unmeasured: false,
  estimated: false,
  measuredLufs: -18.2,
  normDb: -4.8,
  finalLufs: -23,
  peakLimited: false,
  willClip: false,
  predictedPeakDb: -1,
};

/** A buffer of `duration` seconds, with one channel of silence to draw. */
function bufferOf(duration: number): AudioBuffer {
  const samples = new Float32Array(4000);
  return {
    duration,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

/** The 2D context jsdom does not provide, recording nothing but the calls. */
function stubCanvas(width = 800): void {
  const noop = () => {};
  const ctx = {
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    roundRect: noop,
    fillText: noop,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  // Every box in jsdom is zero-sized, and the trimmer maps a pointer's x
  // across the canvas width — a width of zero makes every drag a no-op.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width,
    height: 120,
    right: width,
    bottom: 120,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "setPointerCapture", {
    configurable: true,
    value: noop,
  });
}

let panel: MountedPanel | null = null;
const onTrimChange = vi.fn();
const onClose = vi.fn();

/** Mounts the trimmer on a 10-second sound, already loaded. */
async function openTrimmer(
  props: Partial<Parameters<typeof WaveformTrimmer>[0]> = {},
) {
  panel = await mountPanel(
    <WaveformTrimmer
      audioFileId={7}
      audioFileName="horn.wav"
      trimStart={0}
      trimEnd={0}
      soundGainDb={0}
      padGainDb={0}
      onTrimChange={onTrimChange}
      onClose={onClose}
      {...props}
    />,
  );
  return panel;
}

/** The button whose visible text is `label`, from anywhere in the document. */
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

/** The one canvas the overlay renders. */
function canvas(): HTMLCanvasElement {
  const found = document.body.querySelector("canvas");
  if (!found) throw new Error("the waveform canvas is not rendered");
  return found;
}

/** Dispatches a pointer event React will read `clientX` off. */
function pointer(type: string, clientX: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  canvas().dispatchEvent(event);
}

/**
 * Grabs a handle at `fromX` and drags it to `toX`.
 *
 * The settle between the press and the move is not ceremony: `handlePointerMove`
 * closes over `dragging`, so a move dispatched in the same tick as the press
 * still sees `null` and does nothing at all. A test without it passes whatever
 * the drag logic does.
 */
async function drag(fromX: number, toX: number): Promise<void> {
  pointer("pointerdown", fromX);
  await panel!.settle();
  pointer("pointermove", toX);
  await panel!.settle();
  pointer("pointerup", toX);
  await panel!.settle();
}

/** The overlay's rendered text, for readout assertions. */
const overlayText = () =>
  document.body.querySelector("canvas")?.closest(".fixed")?.textContent ??
  document.body.textContent ??
  "";

beforeEach(() => {
  quietConsole();
  onTrimChange.mockReset();
  onClose.mockReset();
  playBuffer.mockReset();
  stopTrack.mockReset();
  getAudioFile.mockResolvedValue({ id: 7, name: "horn.wav", blob: new Blob() });
  decodeAudioBlob.mockResolvedValue(bufferOf(10));
  getCachedLoudness.mockReturnValue(undefined);
  resolveGain.mockReturnValue(measuredGain);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  stubCanvas();
});

afterEach(async () => {
  await panel?.unmount();
  panel = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loading the sound", () => {
  it("reads the length off the decoded buffer", async () => {
    await openTrimmer();

    expect(overlayText()).toContain("0:10.00");
  });

  it("treats a stored trim end of zero as the whole file", async () => {
    // What an untrimmed sound carries. Read literally it is a cue of no length.
    await openTrimmer({ trimEnd: 0 });

    expect(button("Apply").disabled).toBe(false);
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });

  it("pulls a trim end past the end of the file back to it", async () => {
    // Reachable: trim settings are keyed by audio file id and survive
    // `replaceMissingAudioFile`, so a shorter replacement inherits them.
    await openTrimmer({ trimEnd: 500 });

    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });

  it("keeps a trim end that fits", async () => {
    await openTrimmer({ trimStart: 1, trimEnd: 4 });

    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(1, 4);
  });

  it("says so when the sound cannot be decoded", async () => {
    decodeAudioBlob.mockRejectedValue(
      new Error("Failed to decode audio data."),
    );

    await openTrimmer();

    expect(overlayText()).toContain("Failed to decode audio data.");
    expect(button("Apply").disabled).toBe(true);
    expect(button("Preview").disabled).toBe(true);
  });

  it("reports an unknown failure rather than showing nothing", async () => {
    decodeAudioBlob.mockRejectedValue("not an Error");

    await openTrimmer();

    expect(overlayText()).toContain("Unknown error");
  });

  it("draws an empty range when the row has vanished, and reports no error", async () => {
    // `load` returns early without a duration or peaks, and its `finally`
    // clears the spinner regardless — so the overlay comes up on a
    // zero-length file rather than on an error. Not obviously the right
    // answer, but it is what the code does, and it does not crash.
    getAudioFile.mockResolvedValue(undefined);

    await openTrimmer();

    const text = overlayText();
    expect(text).not.toContain("Loading waveform");
    expect(text).not.toContain("Failed to load audio");
    expect(text).toContain("0:00.00");
  });
});

describe("dragging the handles", () => {
  it("moves the start handle to where the pointer went", async () => {
    // 800px wide over 10 seconds: 240px is 3 seconds.
    await openTrimmer({ trimStart: 0, trimEnd: 10 });

    await drag(0, 240);
    await panel!.press(button("Apply"));

    expect(onTrimChange.mock.calls[0][0]).toBeCloseTo(3);
  });

  it("moves the end handle to where the pointer went", async () => {
    await openTrimmer({ trimStart: 0, trimEnd: 10 });

    await drag(800, 400);
    await panel!.press(button("Apply"));

    expect(onTrimChange.mock.calls[0][1]).toBeCloseTo(5);
  });

  it("keeps the start at least 50ms clear of the end", async () => {
    // A range that crosses is negative-length, and plays nothing.
    await openTrimmer({ trimStart: 0, trimEnd: 2 });

    await drag(0, 800);
    await panel!.press(button("Apply"));

    const [start, end] = onTrimChange.mock.calls[0];
    expect(start).toBeCloseTo(1.95);
    expect(end).toBe(2);
  });

  it("keeps the end at least 50ms clear of the start", async () => {
    await openTrimmer({ trimStart: 5, trimEnd: 10 });

    await drag(800, 0);
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(5, 5.05);
  });

  it("does not let a drag run off either end of the file", async () => {
    await openTrimmer({ trimStart: 0, trimEnd: 10 });

    await drag(800, 5000);
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });

  it("ignores a press nowhere near either handle", async () => {
    await openTrimmer({ trimStart: 0, trimEnd: 10 });

    await drag(400, 700);
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });

  it("takes the nearer handle when both are within reach", async () => {
    // Both handles sit at 0 and 80px; a press at 10px is inside the 20px
    // threshold of the start only.
    await openTrimmer({ trimStart: 0, trimEnd: 1 });

    await drag(10, 320);
    await panel!.press(button("Apply"));

    expect(onTrimChange.mock.calls[0][0]).toBeCloseTo(0.95);
  });

  it("stops moving once the pointer is released", async () => {
    await openTrimmer({ trimStart: 0, trimEnd: 10 });
    pointer("pointerdown", 0);
    await panel!.settle();
    pointer("pointerup", 0);
    await panel!.settle();

    pointer("pointermove", 400);
    await panel!.settle();
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });
});

describe("the buttons", () => {
  it("Reset restores the whole file", async () => {
    await openTrimmer({ trimStart: 2, trimEnd: 8 });

    await panel!.press(button("Reset"));
    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(0, 10);
  });

  it("Apply reports the range and then closes", async () => {
    await openTrimmer({ trimStart: 1, trimEnd: 6 });

    await panel!.press(button("Apply"));

    expect(onTrimChange).toHaveBeenCalledWith(1, 6);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes without reporting a range", async () => {
    await openTrimmer({ trimStart: 1, trimEnd: 6 });

    await panel!.press(button("Cancel"));

    expect(onTrimChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the × in the header closes too", async () => {
    await openTrimmer();

    const close = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Close trimmer"]',
    );
    await panel!.press(close!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the preview", () => {
  it("plays the trimmed range at the resolved level", async () => {
    await openTrimmer({ trimStart: 2, trimEnd: 6 });

    await panel!.press(button("Preview"));

    expect(playBuffer).toHaveBeenCalledTimes(1);
    expect(playBuffer.mock.calls[0][2]).toMatchObject({
      trimStart: 2,
      trimEnd: 6,
      volume: measuredGain.linear,
    });
  });

  it("silences the previous preview before starting another", async () => {
    // Otherwise two presses of Preview overlap, which is not what the button
    // says it does. Two things do this — the explicit stop in `handlePreview`
    // and the cleanup of the effect keyed on `previewKey` — and this
    // assertion cannot tell them apart. Removing the explicit one leaves the
    // suite green; see plans/off-topic-improvements.md.
    await openTrimmer();

    await panel!.press(button("Preview"));
    await panel!.press(button("Preview"));

    const firstKey = playBuffer.mock.calls[0][1];
    expect(stopTrack).toHaveBeenCalledWith(firstKey);
    expect(playBuffer).toHaveBeenCalledTimes(2);
  });

  it("stops the preview when the trimmer is closed", async () => {
    // A sound left running with no visible way to stop it short of the panic
    // button.
    await openTrimmer();
    await panel!.press(button("Preview"));
    const key = playBuffer.mock.calls[0][1];

    await panel!.unmount();
    panel = null;

    expect(stopTrack).toHaveBeenCalledWith(key);
  });

  it("does nothing before the sound has decoded", async () => {
    decodeAudioBlob.mockRejectedValue(new Error("nope"));
    await openTrimmer();

    await panel!.press(button("Preview"));

    expect(playBuffer).not.toHaveBeenCalled();
  });
});

describe("the loudness readout", () => {
  it("says so when the sound has not been analysed", async () => {
    resolveGain.mockReturnValue({ ...measuredGain, unmeasured: true });

    await openTrimmer();

    expect(overlayText()).toContain("Loudness not analysed yet");
  });

  it("shows the measurement, the normalisation and what will be heard", async () => {
    await openTrimmer();

    // A typographic minus, not a hyphen: `formatLufs` and `formatGainDb` use
    // U+2212 so the readout lines up in a tabular-nums column.
    const text = overlayText();
    expect(text).toContain("\u221218.2");
    expect(text).toContain("\u22124.8");
    expect(text).toContain("\u221223.0");
  });

  it("marks an estimate as one", async () => {
    resolveGain.mockReturnValue({ ...measuredGain, estimated: true });

    await openTrimmer();

    expect(overlayText()).toContain("(estimated)");
  });

  it("warns when the level had to be held back by the peak", async () => {
    resolveGain.mockReturnValue({ ...measuredGain, peakLimited: true });

    await openTrimmer();

    expect(overlayText()).toContain("peak limited");
  });

  it("warns when the sound will clip, and by how much", async () => {
    resolveGain.mockReturnValue({
      ...measuredGain,
      willClip: true,
      predictedPeakDb: 2.5,
    });

    await openTrimmer();

    expect(overlayText()).toContain("clips by");
  });

  it("recomputes when an analysis lands while the trimmer is open", async () => {
    // The cache is a plain Map, so React cannot see it change on its own — a
    // just-imported sound analysed in the background would otherwise read
    // "not analysed" until the overlay was reopened.
    resolveGain.mockReturnValue({ ...measuredGain, unmeasured: true });
    await openTrimmer();
    expect(overlayText()).toContain("Loudness not analysed yet");

    resolveGain.mockReturnValue(measuredGain);
    await panel!.press(button("Reset"));
    notifyLoudnessCache?.();
    await panel!.settle();

    expect(overlayText()).not.toContain("Loudness not analysed yet");
  });
});

describe("Escape", () => {
  it("backs out of the trimmer, not the editor underneath", async () => {
    // The pad editor registers its own Escape handler and mounts first; among
    // capture listeners the earlier registration wins, so mounting later is
    // not by itself enough. The shared stack is what settles it.
    await openTrimmer();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
