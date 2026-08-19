// @vitest-environment jsdom
/**
 * Nothing used to call `loadBanks` at runtime, so `profileStore`'s `banks`
 * stayed `[]` forever and every bank switch — tab clicks, number-key
 * shortcuts, all of it — hit `setCurrentPageIndex`'s "bank not found" no-op,
 * because that lookup is against `get().banks`. This reproduces the first
 * failure directly: mounting `ClientSideInitializer` with an active profile
 * must populate `banks` from the database. The assertion checks a renamed
 * bank's *name*, not just the count, so a hardcoded ten-item default could
 * not satisfy it by coincidence.
 *
 * The second test reproduces the reviewer-flagged race: `loadBanks` is a
 * plain async write with no generation token of its own, so switching
 * profiles fast enough to have two calls in flight could let an earlier
 * call's `set` land after a later one and leave the wrong profile's banks on
 * screen. It proves the wiring coalesces to the *last* profile actually
 * asked for, and never issues a call for a profile that was superseded
 * before its turn came up.
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

// Isolates this test from real Drive/server sync and the service worker
// (which imports a build-info.json that only exists after `prebuild` runs).
// None of that machinery is what these tests are about.
vi.mock("@/hooks/useGoogleDriveSync", () => ({
  useGoogleDriveSync: () => ({
    syncProfile: vi.fn(),
    getRemoteVersionToken: vi.fn(),
  }),
}));
vi.mock("@/hooks/useServerSync", () => ({
  useServerSync: () => ({ syncProfile: vi.fn() }),
  subscribeToProfileChanges: vi.fn(() => () => {}),
}));
vi.mock("@/lib/serviceWorker/register", () => ({
  registerServiceWorker: vi.fn(),
}));
vi.mock("@/lib/audio/loudness/pipeline", () => ({
  refreshProfileLoudness: vi.fn(async () => {}),
  subscribeToBackfillProgress: vi.fn(() => () => {}),
}));

const { useProfileStore } = await import("@/store/profileStore");
const { addProfile, ensureDefaultBanks, upsertPageMetadata, getDb } =
  await import("@/lib/db");
const { default: ClientSideInitializer } =
  await import("@/components/ClientSideInitializer");

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

beforeEach(async () => {
  await clearAllStores();
  useProfileStore.setState({
    activeProfileId: null,
    banks: [],
    currentBankId: null,
    currentPageIndex: 0,
  });
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

describe("ClientSideInitializer loads banks for the active profile", () => {
  it("populates the store's bank list on mount, by name and not just by count", async () => {
    const profileId = await addProfile({ name: "Board", syncType: "local" });
    await ensureDefaultBanks(profileId);
    // A name a hardcoded default seed could never produce — proves this
    // reads the real record, not merely a count a stub could also satisfy.
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      name: "Green Room",
    });

    useProfileStore.setState({ activeProfileId: profileId });

    await act(async () => {
      root.render(<ClientSideInitializer>{null}</ClientSideInitializer>);
    });

    await waitFor(() => {
      expect(useProfileStore.getState().banks).toHaveLength(10);
    });

    const banks = useProfileStore.getState().banks;
    const renamedBank = banks.find((bank) => bank.bankId === "0");
    expect(renamedBank?.name).toBe("Green Room");
    expect(useProfileStore.getState().currentBankId).toBe("0");
  });
});

describe("ClientSideInitializer coalesces overlapping loadBanks calls", () => {
  it("converges on the last profile requested and never calls loadBanks for a profile that was superseded before its turn", async () => {
    const realLoadBanks = useProfileStore.getState().loadBanks;

    const profileA = 9001;
    const profileB = 9002;
    const profileC = 9003;

    const calls: number[] = [];
    let resolveFirstCall: (() => void) | undefined;
    const loadBanksMock = vi.fn((profileId: number): Promise<void> => {
      calls.push(profileId);
      if (calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstCall = resolve;
        });
      }
      return Promise.resolve();
    });

    try {
      useProfileStore.setState({
        activeProfileId: profileA,
        loadBanks: loadBanksMock,
      });

      await act(async () => {
        root.render(<ClientSideInitializer>{null}</ClientSideInitializer>);
      });
      // The initial mount already asked for profile A, and that call is
      // still in flight (its promise was never resolved above).
      expect(calls).toEqual([profileA]);

      // A rapid switch while A is still loading must not fire immediately —
      // it should be remembered, not issued.
      await act(async () => {
        useProfileStore.setState({ activeProfileId: profileB });
      });
      expect(calls).toEqual([profileA]);

      // A second switch, still before A resolves, must overwrite the
      // remembered target rather than queueing a second one — B must never
      // be asked for at all.
      await act(async () => {
        useProfileStore.setState({ activeProfileId: profileC });
      });
      expect(calls).toEqual([profileA]);

      // Let A's call settle. The coalesced request for the *last* profile
      // (C) should fire now — and only C, never B.
      act(() => {
        resolveFirstCall?.();
      });
      await waitFor(() => {
        expect(calls).toEqual([profileA, profileC]);
      });
    } finally {
      useProfileStore.setState({ loadBanks: realLoadBanks });
    }
  });
});
