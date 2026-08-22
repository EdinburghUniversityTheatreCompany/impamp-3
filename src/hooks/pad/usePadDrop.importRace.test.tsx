// @vitest-environment jsdom
/**
 * A file dropped on a pad, against the orphan sweep.
 *
 * `handleDropAudio` writes the audio row and the pad naming it in two
 * transactions, with a real event-loop turn between them — the window
 * `cleanupOrphanedAudioFiles` is entitled to delete in, because for that
 * moment the row is referenced by nothing at all. The rule in CLAUDE.md has no
 * exceptions: a writer in that shape declares itself with
 * `withAudioImportInProgress`, or the deleters' `settleAudioImports()` buys
 * nothing because there is nothing registered to wait for.
 *
 * The drop is driven through a real render, as `usePadDrop.dedup.test.tsx`
 * does, because the write lives inside a `useCallback` and there is nothing
 * else to call. `savePadConfiguration` is gated rather than mocked away: the
 * real one still runs, one release later.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import {
  createRaceGate,
  longEnoughToDelete,
  type RaceGate,
} from "@/lib/testSupport/raceGate";

stubLoudnessPipeline();

const profileState = {
  activeProfileId: 1,
  requestSync: vi.fn(),
  incrementPadConfigsVersion: vi.fn(),
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

// The gate sits in front of the pad write and nowhere else, so the drop stops
// with its audio row committed and no pad naming it.
let gate: RaceGate;
vi.doMock("./padWrites", async () => {
  const actual =
    await vi.importActual<typeof import("./padWrites")>("./padWrites");
  return {
    ...actual,
    savePadConfiguration: async (
      pad: Parameters<typeof actual.savePadConfiguration>[0],
    ) => {
      await gate.arrive();
      return actual.savePadConfiguration(pad);
    },
  };
});

const {
  cleanupOrphanedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfileBank,
} = await import("@/lib/db");
const { usePadDrop } = await import("./usePadDrop");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ID = 1;
const BANK_ID = "0";

let container: HTMLDivElement;
let root: Root;
let drop: (files: File[], padIndex: number) => Promise<void>;

function Harness() {
  const { handleDropAudio } = usePadDrop(BANK_ID);
  useEffect(() => {
    drop = handleDropAudio;
  }, [handleDropAudio]);
  return null;
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  gate = createRaceGate();
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

describe("an orphan sweep during a drop", () => {
  it("leaves the sound the drop has been handed but not yet named", async () => {
    const dropping = drop(
      [new File(["the horn bytes"], "horn.wav", { type: "audio/wav" })],
      0,
    );
    await gate.reached;

    // Started inside the window and given every chance to finish. Undeclared,
    // it does: the row is the only one in the store and nothing names it.
    const sweeping = cleanupOrphanedAudioFiles();
    await longEnoughToDelete();
    gate.release();

    await dropping;
    const sweep = await sweeping;

    const [pad] = await getPadConfigurationsForProfileBank(PROFILE_ID, BANK_ID);
    expect(pad.audioFileIds).toHaveLength(1);
    expect(
      await getAudioFile(pad.audioFileIds[0]),
      "the pad names a sound the sweep deleted",
    ).toBeDefined();
    expect(sweep.deletedCount).toBe(0);
  });
});
