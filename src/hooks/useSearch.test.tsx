// @vitest-environment jsdom
/**
 * What a search result carries off the pad it found.
 *
 * `SearchResult` is a hand-built projection of `PadConfiguration` rather than
 * a `PadPlaybackSettings`, and the modal then rebuilds a trigger payload and
 * an armed cue out of it by hand again. So a pad field that the projection
 * forgets is gone by the time the modal sees it, and every one of those three
 * literals is free to omit an optional field without a compiler error.
 *
 * `SearchModal.test.tsx` covers the two consuming literals. This covers the
 * projection they consume.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration, PageMetadata } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  getAllPadConfigurationsForProfile: vi.fn(),
  getAllPageMetadataForProfile: vi.fn(),
  getAudioFileMetadata: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getAllPageMetadataForProfile: mocks.getAllPageMetadataForProfile,
  getAudioFileMetadata: mocks.getAudioFileMetadata,
}));
vi.mock("@/lib/importExport", () => ({
  getAllPadConfigurationsForProfile: mocks.getAllPadConfigurationsForProfile,
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: (selector: (s: { activeProfileId: number }) => unknown) =>
    selector({ activeProfileId: 1 }),
}));

import { useSearch, type SearchResult } from "./useSearch";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function padOnDisk(over: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: 3,
    name: "Horn",
    audioFileIds: [10],
    playbackType: "sequential",
    padGainDb: -3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as PadConfiguration;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.getAllPageMetadataForProfile.mockResolvedValue([
    {
      profileId: 1,
      bankId: "0",
      pageIndex: 0,
      name: "Opening",
    } as PageMetadata,
  ]);
  mocks.getAudioFileMetadata.mockResolvedValue(
    new Map([[10, { name: "horn.wav" }]]),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Searches for "horn" over a board holding exactly `pad`, and returns the hit. */
async function searchFor(pad: PadConfiguration): Promise<SearchResult> {
  mocks.getAllPadConfigurationsForProfile.mockResolvedValue([pad]);

  let latest: ReturnType<typeof useSearch> | undefined;
  function Probe() {
    latest = useSearch();
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
  });
  await act(async () => {
    latest!.setSearchTerm("horn");
  });
  // The hook debounces before it reads anything.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });

  expect(latest!.results).toHaveLength(1);
  return latest!.results[0];
}

describe("a search result", () => {
  it("carries the pad's activePadBehavior override", async () => {
    const result = await searchFor(padOnDisk({ activePadBehavior: "layer" }));

    expect(result).toMatchObject({
      activePadBehavior: "layer",
      // Beside it so a pass cannot mean "the projection copied nothing" —
      // this one has been carried since before the override existed.
      padGainDb: -3,
      padIndex: 3,
    });
  });

  it("leaves a pad with no override following the profile", async () => {
    const result = await searchFor(padOnDisk());

    expect(result).toHaveProperty("activePadBehavior", undefined);
  });
});
