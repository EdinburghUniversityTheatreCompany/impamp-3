// @vitest-environment jsdom
/**
 * A bulk import, against the orphan sweep.
 *
 * The importer walks its assignments writing an audio row and then the pad
 * naming it, one pair per file, and every one of those pairs is two
 * transactions with a turn between them. A folder of sixty stings therefore
 * leaves sixty separate windows in which a row is real and nothing references
 * it — which is what `cleanupOrphanedAudioFiles` exists to delete. The rule in
 * CLAUDE.md has no exceptions: a writer in that shape declares itself with
 * `withAudioImportInProgress`, and the deleters' `settleAudioImports()` buys
 * nothing when there is nothing registered to wait for.
 *
 * Driven through the real component, as `BulkImportModalContent.dedup.test.tsx`
 * is, because the write is inside a click handler and there is nothing else to
 * call. The sweep is fired from the moment the first pad write is reached and
 * deliberately not awaited there — declared, it waits for the import; the
 * import is not waiting for it.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import { mountPanel } from "@/lib/testSupport/reactPanel";
import { createRaceGate, type RaceGate } from "@/lib/testSupport/raceGate";

stubLoudnessPipeline();

const requestSync = vi.fn();
const incrementPadConfigsVersion = vi.fn();
vi.doMock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({ requestSync, incrementPadConfigsVersion }),
  },
}));

// The gate sits in front of the pad write and nowhere else, so the importer
// stops with its first audio row committed and no pad naming it.
//
// On `upsertPadConfiguration` rather than `padWrites.savePadConfiguration`,
// because the loop writes through the former directly — its announcement is
// one per run, not one per pad. Gating the wrapper the importer no longer
// calls does not fail; it hangs, which is a 20-second timeout rather than a
// readable failure, so keep this pointed at whatever the loop actually awaits.
let gate: RaceGate;
vi.doMock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    upsertPadConfiguration: async (
      pad: Parameters<typeof actual.upsertPadConfiguration>[0],
    ) => {
      await gate.arrive();
      return actual.upsertPadConfiguration(pad);
    },
  };
});

const BulkImportModalContent = (
  await import("@/components/modals/BulkImportModalContent")
).default;
const {
  cleanupOrphanedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfileBank,
} = await import("@/lib/db");

const PROFILE_ID = 1;
const BANK_ID = "0";

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  gate = createRaceGate();
});

describe("an orphan sweep during a bulk import", () => {
  it("leaves the sounds the import has been handed but not yet named", async () => {
    const panel = await mountPanel(
      <BulkImportModalContent
        profileId={PROFILE_ID}
        bankId={BANK_ID}
        existingPadConfigs={new Map()}
        onAssignmentComplete={() => {}}
      />,
    );
    const labelled = (label: string): HTMLElement => {
      const found = [...panel.container.querySelectorAll("button")].find(
        (element) => element.textContent?.startsWith(label),
      );
      if (!found) throw new Error(`no button labelled "${label}"`);
      return found;
    };

    const input =
      panel.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [new File(["the horn bytes"], "horn.wav", { type: "audio/wav" })],
      configurable: true,
    });
    await panel.press(input);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.settle();
    await panel.press(labelled("Auto-Assign"));

    // Started the moment the importer reaches its first pad write, and given
    // the whole of the press below to finish. Undeclared it does: the row is
    // the only one in the store and nothing names it.
    const sweeping = gate.reached.then(() => cleanupOrphanedAudioFiles());
    await panel.press(labelled("Save Assignments"));
    gate.release();
    await panel.settle();

    const sweep = await sweeping;
    const [pad] = await getPadConfigurationsForProfileBank(PROFILE_ID, BANK_ID);
    expect(pad.audioFileIds).toHaveLength(1);
    expect(
      await getAudioFile(pad.audioFileIds[0]),
      "the pad names a sound the sweep deleted",
    ).toBeDefined();
    expect(sweep.deletedCount).toBe(0);

    await panel.unmount();
  });
});
