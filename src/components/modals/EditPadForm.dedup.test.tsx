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
import { waitForCondition } from "@/lib/testSupport/reactPanel";
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
  });
  // The wait is a wall clock over the rendered list, not a count of turns
  // inside one `act` scope. The count this replaced was both: 100 × 5 ms of
  // budget, with `soundRows()` read from inside the scope that was holding
  // React's commits — so it was watching a DOM the wait itself kept still, on
  // a budget unrelated to the content hash and IndexedDB write it was waiting
  // for. It failed under `hk`'s parallel load with "expected 2 sounds listed,
  // saw 0" while passing five direct runs.
  await waitForCondition(
    () => soundRows().length >= expectedRows,
    `${expectedRows} sounds to be listed`,
  );
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
    // And both rows read the *stored* row's name. `addOrReuseAudioFile`
    // returns a reused row exactly as it found it, so "horn (1).wav" — the
    // name the second file happened to arrive under — is nobody's name.
    expect(
      soundRows().map((row) => row.querySelector("span")!.textContent),
    ).toEqual(["horn.wav", "horn.wav"]);
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

  it("gives each copy its own test ids and its own accessible names", async () => {
    // A duplicate `data-testid` is as wrong as a duplicate React key, and it
    // is what a `fileId`-keyed id becomes the moment reuse hands two rows one
    // id. Playwright says so out loud — "strict mode violation: … resolved to
    // 2 elements" — but only in the browser, hours later; this is the same
    // fact in jsdom.
    //
    // All four ids are checked together on purpose. The drag id was fixed on
    // its own once and the three beside it were left keyed on `fileId`, which
    // is this repo's characteristic regression: take the data, leave the
    // guard.
    await addSounds([horn("horn.wav")], 1);
    await addSounds([horn("horn (1).wav")], 2);

    const [first, second] = soundRows();
    for (const prefix of [
      "edit-pad-sound-item-",
      "edit-pad-gain-sound-",
      "edit-pad-trim-sound-",
      "edit-pad-remove-sound-",
    ]) {
      const ids = [first, second].map((row) =>
        row.matches(`[data-testid^="${prefix}"]`)
          ? row.getAttribute("data-testid")
          : row
              .querySelector(`[data-testid^="${prefix}"]`)!
              .getAttribute("data-testid"),
      );
      expect(ids[0], `${prefix} is missing`).toBeTruthy();
      expect(ids[0], `${prefix} collides between the two copies`).not.toBe(
        ids[1],
      );
      // And every one of them still answers a document-wide lookup with
      // exactly one element, which is the property a locator relies on.
      for (const id of ids) {
        expect(document.querySelectorAll(`[data-testid="${id}"]`)).toHaveLength(
          1,
        );
      }
    }

    // The same for what a screen reader hears: two "Remove horn.wav" buttons
    // that remove different rows are indistinguishable by ear.
    for (const prefix of ["Remove ", "Trim ", "Gain for "]) {
      const labels = [first, second].map((row) =>
        row
          .querySelector(`[aria-label^="${prefix}"]`)!
          .getAttribute("aria-label")!,
      );
      // Both rows name the same stored row, so both carry the row's own
      // name — "horn.wav", the name it was written under, not "horn (1).wav",
      // the name on the file the second add happened to arrive under.
      expect(labels[0]).toBe(`${prefix}horn.wav`);
      expect(labels[1], `"${prefix}" labels collide`).toBe(
        `${prefix}horn.wav (copy 2)`,
      );
    }
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
