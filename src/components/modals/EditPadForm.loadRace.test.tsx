// @vitest-environment jsdom
/**
 * Adding a sound to a pad whose existing sounds have not finished loading.
 *
 * The editor opens with `values.audioFileIds` already populated and turns
 * each id into a name with an `await getAudioFile(id)` per id. Until that
 * settles, the `sounds` state — the list the user sees — is still empty.
 * Nothing stops the file picker being used in that window: the modal is up,
 * the "Add Sounds" input is live, and a drag-and-drop lands there too.
 *
 * The handler used to build the new list as `[...sounds, ...newSounds]`,
 * which in that window is `[...[], ...newSounds]`, and then wrote that
 * straight into `values.audioFileIds`. Every sound the pad already had was
 * dropped, silently, and the reload the write triggers rebuilt the list from
 * the truncated ids so nothing on screen ever admitted it.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadFormValues } from "@/types/forms";

vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

/**
 * Holds every `getAudioFile` the editor makes until the test lets it go.
 *
 * That read is the whole of the window this file is about, so gating it is
 * what turns "sometimes, on a loaded machine" into a fact that holds every
 * run. `null` means open.
 */
let nameReadGate: Promise<void> | null = null;

vi.doMock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    getAudioFile: async (id: number) => {
      if (nameReadGate) await nameReadGate;
      return actual.getAudioFile(id);
    },
  };
});

const EditPadForm = (await import("@/components/modals/EditPadForm")).default;
const { addOrReuseAudioFile } = await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function horn(name: string): File {
  return new File(["the horn bytes"], name, { type: "audio/wav" });
}

let container: HTMLDivElement;
let root: Root;
/** What the form last held, so the ids that survive a save can be asserted. */
const latestIds: { current: number[] } = { current: [] };

/** Holds the form values, so the effect that reloads the list actually runs. */
function Harness({ initialIds }: { initialIds: number[] }) {
  const [values, setValues] = React.useState<PadFormValues>({
    name: "Horn",
    playbackType: "sequential",
    audioFileIds: initialIds,
    audioGainSettings: undefined,
    padGainDb: undefined,
    isDisabled: false,
    activePadBehavior: undefined,
  });
  React.useEffect(() => {
    latestIds.current = values.audioFileIds ?? [];
  }, [values.audioFileIds]);
  const updateValue = React.useCallback(
    <K extends keyof PadFormValues>(field: K, value: PadFormValues[K]) => {
      setValues((current) => ({ ...current, [field]: value }));
    },
    [],
  );
  return (
    <EditPadForm
      values={values}
      setValues={setValues}
      updateValue={updateValue}
      errors={{}}
      isSubmitting={false}
    />
  );
}

function soundRows(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="edit-pad-sounds-list"] li',
    ),
  ];
}

/**
 * Opens the editor on a pad that already names `ids`, with the name reads
 * held, and adds `files` while they are still held.
 *
 * The dispatch and the release happen in one `act` on purpose: the handler
 * has to start against a list that has not loaded, which is the whole
 * scenario, and then both halves have to be allowed to finish.
 */
async function addBeforeTheListLoads(
  ids: number[],
  files: File[],
): Promise<void> {
  let openGate = () => {};
  nameReadGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  await act(async () => {
    root.render(<Harness initialIds={ids} />);
  });
  // The list is still empty: every read behind it is parked.
  expect(soundRows()).toHaveLength(0);

  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    nameReadGate = null;
    openGate();
    for (let tick = 0; tick < 200; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
}

beforeEach(async () => {
  await clearAllStores();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  nameReadGate = null;
});

describe("adding a sound before the pad's own sounds have loaded", () => {
  it("keeps the sound the pad already had", async () => {
    const { id: existing } = await addOrReuseAudioFile({
      blob: horn("horn.wav"),
      name: "horn.wav",
      type: "audio/wav",
    });

    await addBeforeTheListLoads(
      [existing],
      [
        new File(["a completely different stab"], "stab.wav", {
          type: "audio/wav",
        }),
      ],
    );

    expect(
      soundRows().map((row) => row.querySelector("span")!.textContent),
    ).toEqual(["horn.wav", "stab.wav"]);
    // The form state is the half that survives a save, and it is what the
    // list is rebuilt from, so it has to say the same thing.
    expect(latestIds.current).toHaveLength(2);
    expect(latestIds.current[0]).toBe(existing);
  });

  it("keeps it when the file added is the pad's own sound again", async () => {
    // The e2e shape: reuse by content hash hands back the id the pad already
    // holds, so a lost first copy leaves exactly one row and the collapse
    // looks like dedup doing its job rather than a list being truncated.
    const { id: existing } = await addOrReuseAudioFile({
      blob: horn("horn.wav"),
      name: "horn.wav",
      type: "audio/wav",
    });

    await addBeforeTheListLoads([existing], [horn("horn (1).wav")]);

    expect(soundRows()).toHaveLength(2);
    expect(latestIds.current).toEqual([existing, existing]);
  });
});
