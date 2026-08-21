// @vitest-environment jsdom
/**
 * Dropping the same sound on two pads.
 *
 * This is the path a user takes most often, and it is where duplicate rows
 * were cheapest to make: a board built by dragging a folder of stings onto it
 * pad by pad, then dragging the same sting onto a second bank, stored the
 * bytes twice. The hook is exercised through a real render because the write
 * lives inside a `useCallback` and there is nothing else to call.
 *
 * Its own fixture rather than a shared one: only a drop that happens *twice*
 * can tell reuse from a plain add, and no test elsewhere drops anything.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileState = {
  activeProfileId: 1,
  requestSync: vi.fn(),
  canEditActiveProfile: () => true,
};
const useProfileStore = Object.assign(
  <T,>(selector: (state: typeof profileState) => T) => selector(profileState),
  { getState: () => profileState },
);
vi.doMock("@/store/profileStore", () => ({ useProfileStore }));

// Decoding is Web Audio, which jsdom does not have. The hook only preloads
// with it; nothing here asserts on it.
vi.doMock("@/lib/audio/decoder", () => ({
  loadAndDecodeAudio: vi.fn(async () => null),
}));

const { getDb, getPadConfigurationsForProfileBank } = await import("@/lib/db");
const { usePadDrop } = await import("./usePadDrop");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BANK_ID = "0";

/** The same bytes every time, as a fresh File. */
function horn(name = "horn.wav"): File {
  return new File(["the horn bytes"], name, { type: "audio/wav" });
}

/** Bytes that are not the horn's, so a wrong reuse would be visible. */
function stab(): File {
  return new File(["a completely different stab"], "stab.wav", {
    type: "audio/wav",
  });
}

let container: HTMLDivElement;
let root: Root;
let drop: (files: File[], padIndex: number) => Promise<void>;

/**
 * Renders a host for the hook and captures the drop handler it returns.
 *
 * In an effect rather than during render: capturing it in the render body is
 * a side effect, and the lint rule that says so is right — it would run twice
 * under StrictMode.
 */
function Harness() {
  const { handleDropAudio } = usePadDrop(BANK_ID, () => {});
  useEffect(() => {
    drop = handleDropAudio;
  }, [handleDropAudio]);
  return null;
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("handleDropAudio", () => {
  it("points both pads at one row when the same file is dropped twice", async () => {
    await act(async () => {
      await drop([horn()], 0);
    });
    await act(async () => {
      await drop([horn("horn (1).wav")], 1);
    });

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);

    const pads = await getPadConfigurationsForProfileBank(1, BANK_ID);
    const byIndex = new Map(pads.map((pad) => [pad.padIndex, pad]));
    expect(byIndex.get(0)?.audioFileIds).toEqual([rows[0].id]);
    expect(byIndex.get(1)?.audioFileIds).toEqual([rows[0].id]);
  });

  it("stores a second row for a different sound", async () => {
    // The other half: reuse must not collapse two sounds. Without this, a
    // handler that pointed every drop at the first row would still satisfy
    // the test above.
    await act(async () => {
      await drop([horn()], 0);
    });
    await act(async () => {
      await drop([stab()], 1);
    });

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(2);
    const pads = await getPadConfigurationsForProfileBank(1, BANK_ID);
    const ids = pads.map((pad) => pad.audioFileIds[0]);
    expect(new Set(ids).size).toBe(2);
  });
});
