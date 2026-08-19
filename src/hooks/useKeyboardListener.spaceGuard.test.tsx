// @vitest-environment jsdom
/**
 * `@hello-pangea/dnd`'s keyboard sensor lifts and drops a dragged bank tab
 * on Space, via a `window` keydown listener bound with `capture: true`. The
 * global Space shortcut here (fade out all audio) is bound on `window` at
 * the bubble phase, so the library's capture-phase listener — and its
 * `event.preventDefault()` — always runs first for a Space press aimed at a
 * drag handle. Without checking `event.defaultPrevented`, every Space used
 * to lift or drop a bank tab also faded out whatever was playing — a
 * regression that mattered enough to guard directly, without depending on
 * the real dnd library actually being mounted: this simulates the
 * capture-phase `preventDefault()` dnd performs, which is what the guard
 * reads.
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
}));

vi.mock("@/lib/audio", () => ({
  ensureAudioContextActive: vi.fn(),
  stopAllAudio: vi.fn(),
  fadeOutAllAudio: mocks.fadeOutAllAudio,
  triggerAudioForPadInstant: vi.fn(),
}));

// Both specifiers resolve to the same file (the barrel re-exports it), but
// `useKeyboardListener` imports the barrel and `useIsAnyOverlayOpen` imports
// the file directly — mock both so neither throws for lack of a provider.
const searchContextStub = () => ({
  isSearchModalOpen: false,
  openSearchModal: vi.fn(),
  closeSearchModal: vi.fn(),
});
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

describe("the global Space shortcut defers to a Space already claimed", () => {
  it("fades out all audio on an ordinary Space press", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });

    expect(mocks.fadeOutAllAudio).toHaveBeenCalledTimes(1);
  });

  it("does not fade out audio when something upstream already called preventDefault — the dnd lift/drop case", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    // Simulates `@hello-pangea/dnd`'s capture-phase listener, which runs
    // before this hook's bubble-phase one and calls preventDefault() itself
    // when Space lifts or drops a dragged tab.
    const dndCaptureListener = (event: Event) => {
      event.preventDefault();
    };
    window.addEventListener("keydown", dndCaptureListener, { capture: true });

    try {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: " ",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    } finally {
      window.removeEventListener("keydown", dndCaptureListener, {
        capture: true,
      });
    }

    expect(mocks.fadeOutAllAudio).not.toHaveBeenCalled();
  });
});
