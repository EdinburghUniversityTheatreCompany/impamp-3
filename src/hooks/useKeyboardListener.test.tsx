// @vitest-environment jsdom
/**
 * The two trigger calls in `useKeyboardListener` that bypass `triggerPad`.
 *
 * A pad key and the Enter key both call `triggerAudioForPadInstant` directly,
 * each hand-enumerating the pad's playback fields into its own object literal.
 * They are the only trigger paths that do not go through `triggerPad`, so
 * nothing that fixes a missing field there fixes it here, and `TriggerAudioArgs`
 * declares every one of those fields optional — so a literal that omits one
 * type-checks perfectly and the pad simply plays wrong.
 *
 * Enter goes one hop further: it reads an `EmergencySound`, itself a hand-built
 * projection of the pad (see `emergencySounds.test.ts`), so the field has to
 * survive two copies to arrive.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration } from "@/lib/db";
import type { EmergencySound } from "@/hooks/emergencySounds";

const mocks = vi.hoisted(() => ({
  triggerAudioForPadInstant: vi.fn(),
  ensureAudioContextActive: vi.fn(),
  stopAllAudio: vi.fn(),
  fadeOutAllAudio: vi.fn(),
  takeNextEmergencySound: vi.fn(),
  hasLoadedEmergencySounds: vi.fn(() => true),
  reloadEmergencySounds: vi.fn(async () => {}),
  padConfigs: new Map<number, PadConfiguration>(),
}));

vi.mock("@/lib/audio", () => ({
  triggerAudioForPadInstant: mocks.triggerAudioForPadInstant,
  ensureAudioContextActive: mocks.ensureAudioContextActive,
  stopAllAudio: mocks.stopAllAudio,
  fadeOutAllAudio: mocks.fadeOutAllAudio,
}));
vi.mock("@/hooks/emergencySounds", () => ({
  takeNextEmergencySound: mocks.takeNextEmergencySound,
  hasLoadedEmergencySounds: mocks.hasLoadedEmergencySounds,
  reloadEmergencySounds: mocks.reloadEmergencySounds,
}));
vi.mock("@/hooks/usePadConfigurations", () => ({
  usePadConfigurations: () => ({
    padConfigs: mocks.padConfigs,
    isLoading: false,
  }),
  actionablePadConfigs: (configs: Map<number, PadConfiguration>) => configs,
}));
vi.mock("@/hooks/useIsAnyOverlayOpen", () => ({
  useIsAnyOverlayOpen: () => false,
}));
vi.mock("@/components/search", () => ({
  useSearchContext: () => ({
    openSearchModal: vi.fn(),
    isSearchModalOpen: false,
  }),
}));
vi.mock("@/store/uiStore", () => ({
  useUIStore: (
    selector: (s: { isModalOpen: boolean; modalConfig: null }) => unknown,
  ) => selector({ isModalOpen: false, modalConfig: null }),
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeProfileId: 1,
      currentBankId: "0",
      setCurrentPageIndex: vi.fn(),
      setEditMode: vi.fn(),
      padConfigsVersion: 0,
    }),
}));
vi.mock("@/store/loadingStore", () => ({
  loadingStoreActions: {
    setPadLoadingState: vi.fn(),
    clearPadLoadingState: vi.fn(),
  },
  generatePadLoadingKey: () => "pad-1-0-3",
}));
vi.mock("@/store/playbackStore", () => ({
  playbackStoreActions: { playNextArmedTrack: vi.fn() },
}));
vi.mock("@/lib/uiUtils", () => ({ openHelpModal: vi.fn() }));

import { useKeyboardListener } from "./useKeyboardListener";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The pad this board holds, bound to "q" so the custom-binding branch matches. */
function padOnDisk(over: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: 3,
    name: "Horn",
    keyBinding: "q",
    audioFileIds: [10],
    playbackType: "sequential",
    padGainDb: -3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as PadConfiguration;
}

function emergencySound(over: Partial<EmergencySound> = {}): EmergencySound {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: 3,
    audioFileIds: [10],
    playbackType: "sequential",
    name: "Doorbell",
    padGainDb: -3,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

/** Mounts the listener and presses one key on the document body. */
async function press(key: string) {
  function Probe() {
    useKeyboardListener();
    return null;
  }
  await act(async () => {
    root.render(<Probe />);
  });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    // Two things need draining: the handler is async past its first await, and
    // a pad key sets a 100 ms module-global debounce entry keyed by the key
    // itself. That map outlives the component, so without running the timer
    // out the *second* test to press "q" is silently swallowed.
    await vi.advanceTimersByTimeAsync(150);
  });
}

const engineArgs = () => mocks.triggerAudioForPadInstant.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.hasLoadedEmergencySounds.mockReturnValue(true);
  mocks.padConfigs = new Map();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("a pad key", () => {
  it("carries the pad's activePadBehavior override to the engine", async () => {
    mocks.padConfigs = new Map([
      [3, padOnDisk({ activePadBehavior: "layer" })],
    ]);

    await press("q");

    expect(mocks.triggerAudioForPadInstant).toHaveBeenCalledTimes(1);
    expect(engineArgs()).toMatchObject({
      activePadBehavior: "layer",
      // Beside it so a pass cannot mean "the literal carried nothing at all".
      padGainDb: -3,
      padIndex: 3,
    });
  });

  it("leaves a pad with no override following the profile", async () => {
    mocks.padConfigs = new Map([[3, padOnDisk()]]);

    await press("q");

    expect(engineArgs()).toHaveProperty("activePadBehavior", undefined);
  });
});

describe("the Enter key", () => {
  it("carries the emergency pad's activePadBehavior override to the engine", async () => {
    mocks.takeNextEmergencySound.mockReturnValue(
      emergencySound({ activePadBehavior: "layer" }),
    );

    await press("Enter");

    expect(mocks.triggerAudioForPadInstant).toHaveBeenCalledTimes(1);
    expect(engineArgs()).toMatchObject({
      activePadBehavior: "layer",
      padGainDb: -3,
    });
  });

  it("leaves an emergency pad with no override following the profile", async () => {
    mocks.takeNextEmergencySound.mockReturnValue(emergencySound());

    await press("Enter");

    expect(engineArgs()).toHaveProperty("activePadBehavior", undefined);
  });
});
