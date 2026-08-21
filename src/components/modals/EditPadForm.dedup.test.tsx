// @vitest-environment jsdom
/**
 * Adding the same sound to a pad twice, through the pad editor.
 *
 * Two things meet here. The write reuses by content hash, so both adds now
 * name one audio row — and a pad that names one row twice is a shape the
 * editor had never seen, because every add used to mint a fresh id. Its drag
 * ids were `sound-${fileId}`, so the second copy collided with the first:
 * two `<Draggable>`s with one id, two React children with one key, and a
 * remove button that took out every copy rather than the one clicked.
 *
 * Its own fixture: `activePadBehaviorRadios.test.tsx` renders this same form,
 * but deliberately with no sounds at all, so it cannot see any of this.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadFormValues } from "@/types/forms";

// `db.ts` fires a loudness analysis at every row it creates, and jsdom has no
// Web Audio for it to use. Stubbed so the failure it would log — and the real
// BS.1770 arithmetic behind it — stays out of a test about storage.
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

const EditPadForm = (await import("@/components/modals/EditPadForm")).default;
const { getDb } = await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The same bytes every time, under whatever name. */
function horn(name: string): File {
  return new File(["the horn bytes"], name, { type: "audio/wav" });
}

let container: HTMLDivElement;
let root: Root;

/** Holds the form values, so the effect that reloads the list actually runs. */
function Harness() {
  const [values, setValues] = React.useState<PadFormValues>({
    name: "Horn",
    playbackType: "sequential",
    audioFileIds: [],
    audioGainSettings: undefined,
    padGainDb: undefined,
    isDisabled: false,
    activePadBehavior: undefined,
  });
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

/**
 * Puts files on the hidden input, fires the change the form listens for, and
 * waits for the list to show the sounds it added.
 *
 * The wait is not optional. The handler writes to IndexedDB, whose callbacks
 * are events rather than microtasks, so `act` alone returns while the write
 * is still in flight — and a second add fired on top of that one reads a
 * stale `sounds` and overwrites the first.
 *
 * @param files - What the file picker hands back
 * @param expectedRows - How many sounds the list should hold afterwards
 */
async function addSounds(files: File[], expectedRows: number): Promise<void> {
  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (
      let tick = 0;
      tick < 100 && soundRows().length < expectedRows;
      tick++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  if (soundRows().length !== expectedRows) {
    throw new Error(
      `expected ${expectedRows} sounds listed, saw ${soundRows().length}`,
    );
  }
}

/** The sound rows currently listed, in order. */
function soundRows(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="edit-pad-sounds-list"] li',
    ),
  ];
}

beforeEach(async () => {
  await clearAllStores();
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

describe("adding sounds in the pad editor", () => {
  it("stores one row when the same bytes are added under two names", async () => {
    await addSounds([horn("horn.wav")], 1);
    await addSounds([horn("horn (1).wav")], 2);

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);
    // The pad still names it twice: playing a sound twice in a sequence is a
    // thing a user asks for, and reuse is about the bytes, not the list.
    expect(soundRows()).toHaveLength(2);
  });

  it("removes only the copy whose button was clicked", async () => {
    await addSounds([horn("horn.wav")], 1);
    await addSounds([horn("horn (1).wav")], 2);

    const remove = soundRows()[0].querySelector<HTMLButtonElement>(
      '[data-testid^="edit-pad-remove-sound-"]',
    )!;
    await act(async () => {
      remove.click();
    });

    expect(soundRows()).toHaveLength(1);
  });

  it("stores a second row for a different sound", async () => {
    // The other half: reuse must not collapse two sounds into one row.
    await addSounds([horn("horn.wav")], 1);
    await addSounds(
      [
        new File(["a completely different stab"], "stab.wav", {
          type: "audio/wav",
        }),
      ],
      2,
    );

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(2);
    expect(soundRows()).toHaveLength(2);
  });
});
