// @vitest-environment jsdom
/**
 * `PadGrid` used to call `usePadConfigurations(profileId, currentPageIndex)`
 * — a number — against a hook that has taken `bankId: string | null` since
 * de98e08. `!bankId` was true whenever `currentPageIndex` was `0`, so even
 * bank 1's pads failed to fetch on mount.
 *
 * This mounts `PadGrid` against two distinct banks, using ids that are not
 * equal to any position number (the branch-wide hazard: a migrated bank's id
 * equals `String(pageIndex)`, which would let position-keyed code pass this
 * test by coincidence). It asserts each bank's own configured pad name
 * renders — proving pads actually load through the `bankId` prop, not merely
 * that the prop compiles.
 */
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// No testing-library here, so React does not otherwise know this is a test
// environment — without this, `act()` warns on every call.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useProfileStore } = await import("@/store/profileStore");
const { addProfile, getDb, upsertPadConfiguration } = await import("@/lib/db");
const { default: PadGrid } = await import("@/components/PadGrid");

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
  useProfileStore.setState({ isEditMode: false, isDeleteMoveMode: false });

  const profileId = await addProfile({ name: "Board", syncType: "local" });

  await upsertPadConfiguration({
    profileId,
    bankId: "green-room",
    padIndex: 0,
    audioFileIds: [111],
    playbackType: "sequential",
    name: "Green Room Cue",
  });
  await upsertPadConfiguration({
    profileId,
    bankId: "stage-left",
    padIndex: 0,
    audioFileIds: [222],
    playbackType: "sequential",
    name: "Stage Left Cue",
  });

  useProfileStore.setState({ activeProfileId: profileId });

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

describe("PadGrid fetches pads by bankId", () => {
  it("renders the configured pad for the bank it is given, and only that bank's", async () => {
    await act(async () => {
      root.render(<PadGrid bankId="green-room" />);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Green Room Cue");
    });
    expect(container.textContent).not.toContain("Stage Left Cue");

    await act(async () => {
      root.render(<PadGrid bankId="stage-left" />);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Stage Left Cue");
    });
    expect(container.textContent).not.toContain("Green Room Cue");
  });
});
