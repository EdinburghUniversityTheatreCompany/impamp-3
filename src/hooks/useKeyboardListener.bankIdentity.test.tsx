// @vitest-environment jsdom
/**
 * `useKeyboardListener` used to derive the bank on screen as
 * `String(currentPageIndex)`, exact only for a migrated bank whose id is its
 * position by construction. A bank created after the migration — or one that
 * arrived through a JSON import or a sync from an already-upgraded client,
 * both of which `importExport.ts` already accepts with an explicit,
 * non-positional `bankId` — has a real identity distinct from its position.
 * The bridge either matched nothing there (every keyboard shortcut silently
 * dead on that bank) or matched a *different* migrated bank still holding
 * that numeric id (firing the wrong pads).
 *
 * This reproduces the second failure mode exactly: a bank named "stings"
 * sits at position 3, and a bank literally named "3" still exists — just at
 * a different position, the way a reorder would leave it. Pressing the key
 * bound to pad 0 must fire "stings"'s sound, never "3"'s.
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
  triggerAudioForPadInstant: vi.fn(),
}));

vi.mock("@/lib/audio", () => ({
  ensureAudioContextActive: vi.fn(),
  stopAllAudio: vi.fn(),
  fadeOutAllAudio: vi.fn(),
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
vi.mock("@/components/search", () => ({
  useSearchContext: searchContextStub,
}));
vi.mock("@/components/search/SearchProvider", () => ({
  useSearchContext: searchContextStub,
}));

const { useProfileStore } = await import("@/store/profileStore");
const { useKeyboardListener } = await import("@/hooks/useKeyboardListener");
const { addProfile, getDb, upsertPadConfiguration } = await import("@/lib/db");

async function addBank(
  profileIdArg: number,
  bankId: string,
  pageIndex: number,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.add("pageMetadata", {
    profileId: profileIdArg,
    bankId,
    pageIndex,
    name: bankId,
    isEmergency: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function clearAllStores(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ["profiles", "audioFiles", "padConfigurations", "pageMetadata"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("profiles").clear(),
    tx.objectStore("audioFiles").clear(),
    tx.objectStore("padConfigurations").clear(),
    tx.objectStore("pageMetadata").clear(),
  ]);
  await tx.done;
}

function Harness() {
  useKeyboardListener();
  return null;
}

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
}

let container: HTMLDivElement;
let root: Root;
let profileId: number;

beforeEach(async () => {
  mocks.triggerAudioForPadInstant.mockClear();
  await clearAllStores();
  profileId = await addProfile({ name: "Board", syncType: "local" });

  // A reorder moved bank "3" to position 7 and put a fresh, non-positional
  // bank at position 3 — the exact shape the migrated-bridge cannot tell
  // apart from position 3 holding the bank literally named "3".
  await addBank(profileId, "0", 0);
  await addBank(profileId, "1", 1);
  await addBank(profileId, "2", 2);
  await addBank(profileId, "stings", 3);
  await addBank(profileId, "4", 4);
  await addBank(profileId, "5", 5);
  await addBank(profileId, "6", 6);
  await addBank(profileId, "3", 7);
  await addBank(profileId, "8", 8);
  await addBank(profileId, "9", 9);

  // The correct sound, on the bank actually on screen.
  await upsertPadConfiguration({
    profileId,
    bankId: "stings",
    padIndex: 0,
    audioFileIds: [111],
    playbackType: "sequential",
  });
  // The decoy: what a position-keyed lookup would find instead.
  await upsertPadConfiguration({
    profileId,
    bankId: "3",
    padIndex: 0,
    audioFileIds: [999],
    playbackType: "sequential",
  });

  await useProfileStore.getState().loadBanks(profileId);
  useProfileStore.setState({ activeProfileId: profileId });
  // Bank number 4 (UI) is internal index 3 — the position "stings" holds.
  useProfileStore.getState().setCurrentPageIndex(4);
  expect(useProfileStore.getState().currentBankId).toBe("stings");

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

describe("useKeyboardListener reads the bank by identity", () => {
  it("fires the sound of the bank on screen, not of the bank at its position number", async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    // Let usePadConfigurations' fetch for "stings" settle before pressing
    // the key, or nothing will match yet — indistinguishable from the bug.
    await waitFor(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "q", bubbles: true }),
      );
      expect(mocks.triggerAudioForPadInstant).toHaveBeenCalled();
    });

    expect(mocks.triggerAudioForPadInstant).toHaveBeenCalledTimes(1);
    const call = mocks.triggerAudioForPadInstant.mock.calls[0][0];
    expect(call.currentBankId).toBe("stings");
    expect(call.audioFileIds).toEqual([111]);
  });
});
