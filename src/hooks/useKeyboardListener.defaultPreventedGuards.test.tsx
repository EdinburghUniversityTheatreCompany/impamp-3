// @vitest-environment jsdom
/**
 * A key something upstream already claimed is not this hook's to act on.
 *
 * `@hello-pangea/dnd` claims three keys mid-drag that this hook also owns
 * globally, preventDefault-ing each before handing it on: Escape to cancel
 * (dnd.cjs.js:5227), Space to drop (:5232) and Enter via
 * `preventStandardKeyEvents` (:4957). All three were live bugs. See the guard
 * in useKeyboardListener.ts for why one guard covers them all.
 *
 * These cases simulate the capture-phase `preventDefault()` with a capture
 * listener rather than mounting dnd. That covers this hook's half only: it
 * cannot tell whether dnd really claims the key, and in fact it did not —
 * the tabs were undraggable until `disableInteractiveElementBlocking` landed,
 * so the guard was unreachable while these tests passed. Only
 * e2e-tests/bank-reorder.spec.ts can catch that.
 */
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No testing-library here, so React does not otherwise know this is a test
// environment — without this, `act()` warns on every call.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fadeOutAllAudio: vi.fn(),
  stopAllAudio: vi.fn(),
  triggerAudioForPadInstant: vi.fn(),
}));

// The barrel, with the *real* `triggerPad` over a mocked engine. Both keyboard
// trigger paths go through it, so stubbing it out would leave the assertions
// below watching the test's own stand-in rather than the pad's fields making
// the journey.
vi.mock("@/lib/audio", async () => {
  const { triggerPad } = await vi.importActual<
    typeof import("@/lib/audio/triggerPad")
  >("@/lib/audio/triggerPad");
  return {
    triggerPad,
    ensureAudioContextActive: vi.fn(),
    stopAllAudio: mocks.stopAllAudio,
    fadeOutAllAudio: mocks.fadeOutAllAudio,
  };
});
vi.mock("@/lib/audio/controls", () => ({
  triggerAudioForPadInstant: mocks.triggerAudioForPadInstant,
}));

// Both specifiers resolve to the same file (the barrel re-exports it), but
// `useKeyboardListener` imports the barrel and `useIsAnyOverlayOpen` imports
// the file directly — mock both so neither throws for lack of a provider.
const searchContextStub = () => ({
  isSearchModalOpen: false,
  openSearchModal: vi.fn(),
  closeSearchModal: vi.fn(),
});
// The Enter branch only reaches `triggerAudioForPadInstant` when the
// emergency set has something in it, and the real loader wants a populated
// IndexedDB. One armed cue is all this needs to observe.
vi.mock("@/hooks/emergencySounds", () => ({
  hasLoadedEmergencySounds: () => true,
  reloadEmergencySounds: vi.fn(async () => {}),
  takeNextEmergencySound: () => ({
    profileId: 1,
    bankId: "bank-1",
    padIndex: 0,
    audioFileIds: [1],
    playbackType: "sequential",
    name: "Emergency cue",
  }),
}));

vi.mock("@/components/search", () => ({
  useSearchContext: searchContextStub,
}));
vi.mock("@/components/search/SearchProvider", () => ({
  useSearchContext: searchContextStub,
}));

const { useKeyboardListener } = await import("@/hooks/useKeyboardListener");

function Harness() {
  useKeyboardListener();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.fadeOutAllAudio.mockClear();
  mocks.stopAllAudio.mockClear();
  mocks.triggerAudioForPadInstant.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/**
 * Mount the hook and send it one keydown on `window`.
 *
 * With `claimedUpstream`, a capture-phase listener calls `preventDefault()`
 * first — standing in for the dragging bindings dnd has bound on `window`.
 */
async function press(
  key: string,
  { claimedUpstream }: { claimedUpstream: boolean },
): Promise<void> {
  await act(async () => {
    root.render(<Harness />);
  });

  const dndCaptureListener = (event: Event) => {
    event.preventDefault();
  };
  if (claimedUpstream) {
    window.addEventListener("keydown", dndCaptureListener, { capture: true });
  }

  try {
    // `await act(async …)` rather than the sync form: the Enter branch awaits
    // its way to `triggerAudioForPadInstant`, so a sync dispatch would assert
    // before the call it is looking for had happened.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  } finally {
    window.removeEventListener("keydown", dndCaptureListener, {
      capture: true,
    });
  }
}

// One row per branch dnd's dragging bindings preventDefault() out from under
// us. Kept as a table on purpose: the two guards are the same rule written
// twice, so the test for them should not be.
const claimedShortcuts = [
  {
    label: "Escape",
    key: "Escape",
    effect: "stops all audio",
    action: mocks.stopAllAudio,
  },
  {
    label: "Space",
    key: " ",
    effect: "fades out all audio",
    action: mocks.fadeOutAllAudio,
  },
  {
    label: "Enter",
    key: "Enter",
    effect: "fires an emergency cue",
    action: mocks.triggerAudioForPadInstant,
  },
];

describe.each(claimedShortcuts)(
  "the global $label shortcut",
  ({ key, effect, action }) => {
    it(`${effect} on an ordinary press`, async () => {
      await press(key, { claimedUpstream: false });

      expect(action).toHaveBeenCalledTimes(1);
    });

    it("does nothing when something upstream already called preventDefault — the dnd drag case", async () => {
      await press(key, { claimedUpstream: true });

      expect(action).not.toHaveBeenCalled();
    });
  },
);
