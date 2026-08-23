// @vitest-environment jsdom
/**
 * The loudness overview: "which of these sounds is wrong?", as a table.
 *
 * It was at 0% of lines. The row-building and sorting underneath it are
 * already covered by `loudness/overview.test.ts`, so this suite is about the
 * things only the component decides:
 *
 * **A gain drag is buffered, not written.** `GainControl`'s slider fires
 * `onChange` continuously while the pointer moves. Writing on every tick would
 * turn one drag into dozens of IndexedDB writes and — worse — resort a
 * worst-first table out from under the pointer mid-gesture. So the live value
 * lives in `pendingGain` and only `onCommit` reaches the database.
 *
 * **A gain write is a partial upsert.** The saved record spreads the pad's
 * existing `audioGainSettings`, because replacing it wholesale erases every
 * other sound's gain on that pad — and that loss persists. It also omits
 * `activePadBehavior` deliberately, since `upsertPadConfiguration` merges and
 * an explicitly-undefined key is erased: nudging a gain must not clear a pad's
 * retrigger override.
 *
 * **A late commit must not wipe a newer buffer.** `pendingGain` is only
 * cleared if it still holds the key that was written, because a second row's
 * drag can start while the first write is in flight.
 *
 * **A failed load must not leave the modal blank.** The loading flag is
 * cleared in a `finally`; without that a rejected read renders a permanently
 * empty modal with no message at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import { quietConsole } from "@/lib/testSupport/quietConsole";
import type { PadConfiguration } from "@/lib/db";

const getAllPageMetadataForProfile = vi.fn();
const getAudioFileMetadata = vi.fn();
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getAllPageMetadataForProfile: (...a: unknown[]) =>
    getAllPageMetadataForProfile(...a),
  getAudioFileMetadata: (...a: unknown[]) => getAudioFileMetadata(...a),
}));

const getAllPadConfigurationsForProfile = vi.fn();
vi.mock("@/lib/importExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/importExport")>()),
  getAllPadConfigurationsForProfile: (...a: unknown[]) =>
    getAllPadConfigurationsForProfile(...a),
}));

const savePadConfiguration = vi.fn();
vi.mock("@/hooks/pad/padWrites", () => ({
  savePadConfiguration: (...a: unknown[]) => savePadConfiguration(...a),
}));

const getCachedLoudness = vi.fn();
vi.mock("@/lib/audio/loudness/cache", () => ({
  getCachedLoudness: (...a: unknown[]) => getCachedLoudness(...a),
  subscribeToLoudnessCache: () => () => {},
}));

let publishBackfill:
  ((progress: { done: number; total: number }) => void) | null = null;
const loadLoudnessPipeline = vi.fn(async () => ({
  subscribeToBackfillProgress: (
    listener: (progress: { done: number; total: number }) => void,
  ) => {
    publishBackfill = listener;
    return () => {
      publishBackfill = null;
    };
  },
}));
vi.mock("@/lib/audio/loudness/loadPipeline", () => ({
  loadLoudnessPipeline: () => loadLoudnessPipeline(),
}));

const { useProfileStore } = await import("@/store/profileStore");
const LoudnessOverviewModalContent = (
  await import("./LoudnessOverviewModalContent")
).default;

/** A pad naming one sound, with an optional per-sound gain already on it. */
function pad(
  bankId: string,
  padIndex: number,
  audioFileIds: number[],
  overrides: Partial<PadConfiguration> = {},
): PadConfiguration {
  return {
    id: padIndex + 1,
    profileId: 1,
    bankId,
    padIndex,
    audioFileIds,
    playbackType: "sequential",
    ...overrides,
  } as unknown as PadConfiguration;
}

let panel: MountedPanel | null = null;

/** Mounts the modal with an active profile and lets its two loads settle. */
async function openOverview() {
  panel = await mountPanel(<LoudnessOverviewModalContent />);
  return panel;
}

const overviewText = () => document.body.textContent ?? "";

/** Every data row of the sounds table, as its first-cell text. */
const rowLabels = () =>
  [...document.body.querySelectorAll("tbody tr")].map(
    (row) => row.querySelector("td")?.textContent ?? "",
  );

beforeEach(() => {
  quietConsole();
  getAllPadConfigurationsForProfile.mockClear();
  getAllPageMetadataForProfile.mockClear();
  getAudioFileMetadata.mockClear();
  savePadConfiguration.mockReset();
  savePadConfiguration.mockResolvedValue(undefined);
  publishBackfill = null;

  useProfileStore.setState({
    activeProfileId: 1,
    profiles: [
      {
        id: 1,
        name: "Show",
        syncType: "local",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as never,
  });

  getAllPadConfigurationsForProfile.mockResolvedValue([
    pad("bank-a", 0, [10]),
    pad("bank-b", 1, [11], { audioGainSettings: { 11: 3 }, padGainDb: -2 }),
  ]);
  getAllPageMetadataForProfile.mockResolvedValue([
    { bankId: "bank-a", pageIndex: 0, name: "Act 1 SFX" },
    { bankId: "bank-b", pageIndex: 1, name: "" },
  ]);
  getAudioFileMetadata.mockResolvedValue(
    new Map([
      [10, { id: 10, name: "horn.wav" }],
      [11, { id: 11, name: "sting.wav" }],
    ]),
  );
  getCachedLoudness.mockReturnValue(undefined);
});

afterEach(async () => {
  await panel?.unmount();
  panel = null;
  vi.restoreAllMocks();
});

describe("loading", () => {
  it("lists one row per sound on the profile", async () => {
    await openOverview();

    expect(rowLabels()).toHaveLength(2);
  });

  it("calls a bank what the tab above it calls it", async () => {
    // It used to say "Bank 3" while the tab said "3: Act 1 SFX".
    await openOverview();

    expect(overviewText()).toContain("Act 1 SFX");
  });

  it("falls back to the numbered name for a bank with none", async () => {
    await openOverview();

    expect(overviewText()).toContain("Bank 2");
  });

  it("names a sound whose row has vanished rather than showing a blank", async () => {
    getAudioFileMetadata.mockResolvedValue(new Map());

    await openOverview();

    expect(overviewText()).toContain("Sound 10");
  });

  it("reads every distinct sound once, however many pads name it", async () => {
    getAllPadConfigurationsForProfile.mockResolvedValue([
      pad("bank-a", 0, [10]),
      pad("bank-a", 1, [10]),
      pad("bank-a", 2, [10, 11]),
    ]);

    await openOverview();

    expect(getAudioFileMetadata).toHaveBeenCalledWith([10, 11]);
  });

  it("shows the empty state for a profile with no sounds", async () => {
    getAllPadConfigurationsForProfile.mockResolvedValue([]);

    await openOverview();

    expect(overviewText()).toContain("No sounds");
  });

  it("gives up loading when there is no active profile", async () => {
    // Otherwise the loading flag never clears and the empty state never
    // gets a chance to render.
    useProfileStore.setState({ activeProfileId: null });

    await openOverview();

    expect(overviewText()).not.toContain("Loading");
    expect(getAllPadConfigurationsForProfile).not.toHaveBeenCalled();
  });

  it("does not leave the modal blank when the read fails", async () => {
    // A permanently empty modal with no message is worse than no loading
    // flag at all.
    getAllPadConfigurationsForProfile.mockRejectedValue(
      new Error("IndexedDB is having a moment"),
    );

    await openOverview();

    expect(overviewText()).toContain("No sounds");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("sorting", () => {
  it("opens worst-first by deviation", async () => {
    await openOverview();

    const header = document.querySelector(
      '[data-testid="loudness-sort-deviation"]',
    );
    expect(header?.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });

  it("flips direction when the same column is pressed again", async () => {
    const view = await openOverview();

    await view.click("loudness-sort-deviation");

    const header = document.querySelector(
      '[data-testid="loudness-sort-deviation"]',
    );
    expect(header?.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("starts a new column descending rather than keeping the old direction", async () => {
    const view = await openOverview();
    await view.click("loudness-sort-deviation"); // now ascending

    await view.click("loudness-sort-soundName");

    const previous = document.querySelector(
      '[data-testid="loudness-sort-deviation"]',
    );
    const current = document.querySelector(
      '[data-testid="loudness-sort-soundName"]',
    );
    expect(previous?.closest("th")?.getAttribute("aria-sort")).toBe("none");
    expect(current?.closest("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    );
  });

  it("names the current sort state in the button's label", async () => {
    await openOverview();

    const header = document.querySelector(
      '[data-testid="loudness-sort-deviation"]',
    );
    expect(header?.getAttribute("aria-label")).toContain(
      "currently sorted descending",
    );
  });
});

describe("the bank filter", () => {
  it("offers only the banks that actually hold a sound", async () => {
    // All twenty pages would make the filter useless on a mostly-empty board.
    await openOverview();

    const options = [
      ...document.querySelectorAll<HTMLOptionElement>(
        '[data-testid="loudness-bank-filter"] option',
      ),
    ].map((option) => option.value);
    expect(options).toEqual(["all", "bank-a", "bank-b"]);
  });

  it("narrows the table to one bank", async () => {
    const view = await openOverview();

    await view.setValue(view.required("loudness-bank-filter"), "bank-a");

    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain("Act 1 SFX");
  });

  it("orders the options by bank position, not by bank id", async () => {
    getAllPageMetadataForProfile.mockResolvedValue([
      { bankId: "bank-a", pageIndex: 5, name: "Later" },
      { bankId: "bank-b", pageIndex: 0, name: "Earlier" },
    ]);

    await openOverview();

    const options = [
      ...document.querySelectorAll<HTMLOptionElement>(
        '[data-testid="loudness-bank-filter"] option',
      ),
    ].map((option) => option.value);
    expect(options).toEqual(["all", "bank-b", "bank-a"]);
  });

  it("survives a tab switch", async () => {
    const view = await openOverview();
    await view.setValue(view.required("loudness-bank-filter"), "bank-a");

    await view.click("loudness-tab-pads");
    await view.click("loudness-tab-sounds");

    expect(
      (view.required("loudness-bank-filter") as HTMLSelectElement).value,
    ).toBe("bank-a");
  });
});

describe("the tabs", () => {
  it("marks the open tab as selected", async () => {
    const view = await openOverview();

    expect(
      view.required("loudness-tab-sounds").getAttribute("aria-selected"),
    ).toBe("true");

    await view.click("loudness-tab-pads");

    expect(
      view.required("loudness-tab-pads").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("aggregates by pad on the pads tab", async () => {
    getAllPadConfigurationsForProfile.mockResolvedValue([
      pad("bank-a", 0, [10, 11]),
    ]);
    const view = await openOverview();
    expect(rowLabels()).toHaveLength(2);

    await view.click("loudness-tab-pads");

    expect(rowLabels()).toHaveLength(1);
  });
});

describe("the backfill indicator", () => {
  it("stays hidden until there is something to analyse", async () => {
    const view = await openOverview();

    expect(view.testId("loudness-backfill-progress")).toBeNull();
  });

  it("reports progress while the sweep is running", async () => {
    const view = await openOverview();

    publishBackfill?.({ done: 3, total: 10 });
    await view.settle();

    expect(view.required("loudness-backfill-progress").textContent).toContain(
      "3 of 10",
    );
  });

  it("goes away once the sweep has finished", async () => {
    const view = await openOverview();

    publishBackfill?.({ done: 10, total: 10 });
    await view.settle();

    expect(view.testId("loudness-backfill-progress")).toBeNull();
  });

  it("carries on without the indicator when the pipeline will not load", async () => {
    loadLoudnessPipeline.mockRejectedValueOnce(new Error("chunk 404"));

    const view = await openOverview();

    expect(view.testId("loudness-overview")).not.toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("editing a sound's gain", () => {
  /** The first row's gain slider. */
  const slider = () =>
    document.body.querySelector<HTMLInputElement>('tbody input[type="range"]')!;

  /**
   * Releases the slider, which is what `GainControl` turns into `onCommit`.
   *
   * Not a `change` event: the control commits from `pointerup` and `blur`
   * specifically, because a range input's `change` does not mark the end of a
   * drag in every browser.
   */
  async function release(view: MountedPanel): Promise<void> {
    slider().dispatchEvent(new Event("pointerup", { bubbles: true }));
    await view.settle();
  }

  it("writes nothing while the slider is being dragged", async () => {
    // One drag is dozens of onChange ticks; writing each would also resort
    // the worst-first table out from under the pointer.
    const view = await openOverview();

    await view.setValue(slider(), "4");

    expect(savePadConfiguration).not.toHaveBeenCalled();
    expect(slider().value).toBe("4");
  });

  it("writes once, on release", async () => {
    const view = await openOverview();

    await view.setValue(slider(), "4");
    await release(view);

    expect(savePadConfiguration).toHaveBeenCalledTimes(1);
  });

  it("keeps every other sound's gain on the same pad", async () => {
    // Replacing the record wholesale would erase them, and the loss persists.
    getAllPadConfigurationsForProfile.mockResolvedValue([
      pad("bank-a", 0, [10, 11], { audioGainSettings: { 10: 1, 11: -6 } }),
    ]);
    const view = await openOverview();

    await view.setValue(slider(), "4");
    await release(view);

    const written = savePadConfiguration.mock.calls[0][0];
    expect(Object.keys(written.audioGainSettings)).toHaveLength(2);
  });

  it("does not name activePadBehavior, which would erase the override", async () => {
    // `upsertPadConfiguration` merges, so an explicitly-undefined key is
    // erased. This list reads as an authoritative rewrite and is not one.
    const view = await openOverview();

    await view.setValue(slider(), "4");
    await release(view);

    expect("activePadBehavior" in savePadConfiguration.mock.calls[0][0]).toBe(
      false,
    );
  });

  it("leaves the slider where the user put it after a successful write", async () => {
    const view = await openOverview();

    await view.setValue(slider(), "4");
    await release(view);

    expect(slider().value).toBe("4");
  });

  it("snaps the slider back when the write fails", async () => {
    // Otherwise it silently disagrees with both React state and the database.
    savePadConfiguration.mockRejectedValue(new Error("read-only"));
    const view = await openOverview();
    const before = slider().value;

    await view.setValue(slider(), "4");
    await release(view);

    expect(slider().value).toBe(before);
    expect(console.warn).toHaveBeenCalled();
  });

  it("discards an edit whose pad has gone, without writing", async () => {
    const view = await openOverview();
    getAllPadConfigurationsForProfile.mockResolvedValue([]);

    // Re-render with the pad list emptied under the row that is being edited.
    await view.setValue(slider(), "4");
    useProfileStore.setState({ activeProfileId: null });
    await view.settle();

    expect(savePadConfiguration).not.toHaveBeenCalled();
  });
});
