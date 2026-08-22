// @vitest-environment jsdom
/**
 * The pad editor's open window, against the orphan sweep.
 *
 * Picking a sound writes its audio row straight away — the list and the
 * trimmer both read it back by id — and the pad naming it is written on Save.
 * Between the two there is a row nothing references, and unlike every other
 * writer of this shape the gap is not two transactions a turn apart but two
 * user actions, which can be minutes. `cleanupOrphanedAudioFiles` is entitled
 * to delete exactly what sits there, so the save lands on a sound that is
 * already gone: a pad that renders normally and is silent for ever.
 *
 * There is no callback to wrap, so the editor holds the register by hand from
 * mount to unmount (`beginAudioImport`). This drives the real component and
 * fires the sweep while the editor is open, which is the only way this can
 * regress — a unit test of the register itself would stay green if the editor
 * stopped taking the hold.
 *
 * The save is spelt out here rather than driven through `useFormModal`,
 * because `onSubmit` lives in `usePadInteractions` and the modal machinery is
 * not what is under test. It is the same two steps in the same order as the
 * real one: write the pad, then tell the session those ids are kept.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";
import { longEnoughToDelete } from "@/lib/testSupport/raceGate";
import type { PadFormValues } from "@/types/forms";

stubLoudnessPipeline();

const EditPadModalContent = (
  await import("@/components/modals/EditPadModalContent")
).default;
const { createPadEditSession } =
  await import("@/components/modals/padEditSession");
type PadEditSession = ReturnType<typeof createPadEditSession>;
const {
  addProfile,
  cleanupOrphanedAudioFiles,
  getAudioFile,
  getPadConfigurationsForProfileBank,
  upsertPadConfiguration,
} = await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BANK_ID = "0";
const PAD_INDEX = 0;

let container: HTMLDivElement;
let root: Root;
let session: PadEditSession;

/** Enough of the form-modal contract for the editor to render and be typed in. */
function Editor() {
  const [values, setValues] = React.useState<PadFormValues>({
    name: "Horn",
    playbackType: "sequential",
    audioFileIds: [],
    audioGainSettings: undefined,
    padGainDb: undefined,
    isDisabled: false,
    activePadBehavior: undefined,
  });
  return (
    <EditPadModalContent
      session={session}
      values={values}
      setValues={setValues}
      updateValue={(field, value) =>
        setValues((current) => ({ ...current, [field]: value }))
      }
      errors={{}}
      isSubmitting={false}
    />
  );
}

/** Picks a file and waits for the session to be told about the row it wrote. */
async function pickSound(): Promise<number> {
  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["the horn bytes"], "horn.wav", { type: "audio/wav" })],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let tick = 0; tick < 100 && !session.provisionalFileIds.size; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  const [provisional] = [...session.provisionalFileIds];
  if (provisional === undefined) throw new Error("no sound was written");
  return provisional;
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  session = createPadEditSession();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Editor />);
  });
});

afterEach(() => {
  container.remove();
});

describe("an orphan sweep while the pad editor is open", () => {
  it("leaves the sound the editor has written but not yet saved", async () => {
    const profileId = await addProfile({
      name: "Only Show",
      syncType: "local",
      backupReminderPeriod: 7,
    });
    const provisional = await pickSound();

    // Started while the editor is open and given every chance to finish.
    // Undeclared it does: the row is the only one in the store and no pad
    // names it until Save.
    const sweeping = cleanupOrphanedAudioFiles();
    await longEnoughToDelete();

    // Save, as `usePadInteractions`' onSubmit does it: the pad first, then the
    // ids the session must not discard.
    await upsertPadConfiguration({
      profileId,
      bankId: BANK_ID,
      padIndex: PAD_INDEX,
      name: "Horn",
      audioFileIds: [provisional],
      playbackType: "sequential",
    });
    session.savedFileIds = [provisional];

    await act(async () => {
      root.unmount();
    });
    const sweep = await sweeping;

    const [pad] = await getPadConfigurationsForProfileBank(profileId, BANK_ID);
    expect(pad.audioFileIds).toEqual([provisional]);
    expect(
      await getAudioFile(provisional),
      "the saved pad names a sound the sweep deleted",
    ).toBeDefined();
    expect(sweep.deletedCount).toBe(0);
  });
});
