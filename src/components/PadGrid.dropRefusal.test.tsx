// @vitest-environment jsdom
/**
 * What a pad says when it refuses a dropped file.
 *
 * `PadGrid` decides per render whether each pad accepts a drop, and the
 * dropzone is only `disabled` for special pads and delete/move mode — so for
 * every other refusal react-dropzone still fires, the handler still runs, and
 * the file used to go nowhere with nothing written, logged or shown. Every
 * other refusal on that path says something: `console.error` for no profile,
 * `console.warn` for a profile that takes no changes, an `alert` for a write
 * that threw.
 *
 * It is reachable. A file dropped in the few milliseconds after a profile
 * switch, while `canEditActiveProfile` is still settling, lands in the silent
 * branch — measured while writing `e2e-tests/bank-transfer.spec.ts`, where the
 * first drop into a just-created profile was lost every run and the same drop
 * moments later took every run.
 *
 * `Pad` is stubbed to a props recorder rather than rendered: what is under
 * test is which handler `PadGrid` hands each pad, and driving a real
 * react-dropzone through jsdom would assert on the library instead.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedPadProps {
  padIndex: number;
  onDropAudio: (files: File[]) => Promise<void>;
}

const mocks = vi.hoisted(() => ({
  pads: [] as RecordedPadProps[],
  // Typed, so the assertion on which pad index it was handed is checked
  // rather than reaching into an empty tuple.
  handleDropAudio: vi.fn<(files: File[], padIndex: number) => Promise<void>>(
    async () => {},
  ),
  refusal: null as string | null,
}));

vi.mock("@/components/Pad", () => ({
  default: (props: RecordedPadProps) => {
    mocks.pads.push(props);
    return null;
  },
}));
vi.mock("@/hooks/pad", () => ({
  usePadDrop: () => ({
    handleDropAudio: mocks.handleDropAudio,
    dropRefusalReason: () => mocks.refusal,
  }),
  usePadInteractions: () => ({
    handleRemoveInteraction: vi.fn(),
    handleEditInteraction: vi.fn(),
    handlePlaybackInteraction: vi.fn(),
    handleArmTrack: vi.fn(),
  }),
  usePadSwap: () => ({ handleSwapPads: vi.fn() }),
}));
vi.mock("@/hooks/usePadConfigurations", () => ({
  usePadConfigurations: () => ({
    padConfigs: new Map(),
    isLoading: false,
    error: null,
  }),
  actionablePadConfigs: (configs: Map<number, unknown>) => configs,
}));
vi.mock("@/lib/audio", () => ({
  stopAllAudio: vi.fn(),
  fadeOutAllAudio: vi.fn(),
  preloadCurrentPageIntelligent: vi.fn(),
}));
vi.mock("@/hooks/modal/useModal", () => ({
  useModal: () => ({ openLazyModal: vi.fn(), closeModal: vi.fn() }),
}));
vi.mock("@/store/playbackStore", () => ({
  useArmedTracks: () => new Map(),
}));
vi.mock("@/store/loadingStore", () => ({
  usePadLoadingState: () => null,
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeProfileId: 1,
      isEditMode: false,
      isDeleteMoveMode: false,
    }),
}));

import PadGrid from "@/components/PadGrid";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pads = [];
  mocks.refusal = null;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  warn.mockRestore();
});

/** Renders the grid and drops one file on the first ordinary pad. */
async function dropOnFirstPad(): Promise<void> {
  await act(async () => {
    root.render(<PadGrid bankId="0" />);
  });

  const pad = mocks.pads.find((p) => p.padIndex === 0);
  expect(pad).toBeDefined();

  await act(async () => {
    await pad!.onDropAudio([
      new File(["some bytes"], "horn.wav", { type: "audio/wav" }),
    ]);
  });
}

describe("a drop on a pad that will not take it", () => {
  it("says which pad refused it and why", async () => {
    mocks.refusal = "this profile does not accept changes";

    await dropOnFirstPad();

    expect(mocks.handleDropAudio).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.calls[0][0]);
    // Both halves, because either alone is useless during a show: which pad
    // swallowed the file, and why it did.
    expect(said).toContain("pad 0");
    expect(said).toContain("this profile does not accept changes");
  });

  it("stays quiet and writes the file when the pad accepts it", async () => {
    mocks.refusal = null;

    await dropOnFirstPad();

    expect(mocks.handleDropAudio).toHaveBeenCalledTimes(1);
    expect(mocks.handleDropAudio.mock.calls[0][1]).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
