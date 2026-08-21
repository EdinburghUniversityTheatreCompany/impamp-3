// @vitest-environment jsdom
/**
 * Closing the pad editor without saving, once adds reuse rows by content hash.
 *
 * The editor writes every added sound to IndexedDB straight away, so the list
 * and the trimmer can read it back, and discards those ids again on unmount.
 * That was safe while each add minted a fresh row: a "provisional" id named
 * bytes nobody else had. Reuse ends that. The id now handed back is routinely
 * the id of a row that already exists and is already referenced, so a discard
 * that deletes by id alone takes somebody else's sound with it — and Escape,
 * the X and an overlay click all take the unmount path, so this is the
 * ordinary way people close the modal, not a corner.
 *
 * Both halves are tested, because both must hold:
 *   - a row some pad still names survives the cancel;
 *   - a row genuinely created by this edit does not, or cancelling would
 *     silently accumulate orphans.
 *
 * Its own fixture rather than `EditPadForm.dedup.test.tsx`'s: that one renders
 * the form alone, which has no discard behaviour to observe. This renders the
 * component that owns the session and the unmount effect.
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

const EditPadModalContent = (
  await import("@/components/modals/EditPadModalContent")
).default;
const { createPadEditSession } =
  await import("@/components/modals/EditPadModalContent");
type PadEditSession = ReturnType<typeof createPadEditSession>;
const { getDb, addOrReuseAudioFile, addProfile, upsertPadConfiguration } =
  await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The same bytes every time, under whatever name. */
function horn(name: string): File {
  return new File(["the horn bytes"], name, { type: "audio/wav" });
}

/** Different bytes, so this is a second row rather than a reuse of the horn. */
function stab(name: string): File {
  return new File(["a completely different stab"], name, {
    type: "audio/wav",
  });
}

let container: HTMLDivElement;
let root: Root;
let mounted = false;

/** Holds the form values, so the effect that reloads the sound list runs. */
function Harness({
  session,
  initialAudioFileIds,
}: {
  session: PadEditSession;
  initialAudioFileIds: number[];
}) {
  const [values, setValues] = React.useState<PadFormValues>({
    name: "Horn",
    playbackType: "sequential",
    audioFileIds: initialAudioFileIds,
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
    <EditPadModalContent
      session={session}
      values={values}
      setValues={setValues}
      updateValue={updateValue}
      errors={{}}
      isSubmitting={false}
    />
  );
}

/** The sound rows currently listed, in order. */
function soundRows(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="edit-pad-sounds-list"] li',
    ),
  ];
}

/** Opens the editor on a pad holding these sounds, and returns its session. */
async function openEditor(initialAudioFileIds: number[] = []): Promise<{
  session: PadEditSession;
}> {
  const session = createPadEditSession();
  await act(async () => {
    root.render(
      <Harness session={session} initialAudioFileIds={initialAudioFileIds} />,
    );
  });
  mounted = true;
  return { session };
}

/**
 * Puts files on the hidden input, fires the change the form listens for, and
 * waits for the list to show the sounds it added.
 *
 * The wait is not optional: the handler writes to IndexedDB, whose callbacks
 * are events rather than microtasks, so `act` alone returns while the write is
 * still in flight.
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

/**
 * Escape, the X and an overlay click all close the modal by unmounting, so
 * that is what a cancel is here.
 *
 * The discard is a floating promise the effect does not await, so the wait
 * after it is what lets the delete — and the reads it makes first — finish.
 */
async function cancelEditor(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  mounted = false;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  await clearAllStores();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = false;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      root.unmount();
    });
  }
  container.remove();
});

describe("cancelling the pad editor", () => {
  it("keeps a sound the pad being edited already holds (one profile)", async () => {
    // No second profile needed. The pad holds horn.wav; the user adds the same
    // file again — playing a sound twice in a sequence is a thing people do —
    // and then changes their mind.
    const { id: hornId } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn("horn.wav"),
    });
    const profileId = await addProfile({
      name: "Only Show",
      syncType: "local",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      audioFileIds: [hornId],
      playbackType: "sequential",
    });

    const { session } = await openEditor([hornId]);
    await addSounds([horn("horn.wav")], 2);

    // The add reused the pad's own row rather than minting a second one, so
    // the id the session now calls provisional is the pad's saved sound.
    expect([...session.provisionalFileIds]).toEqual([hornId]);

    await cancelEditor();

    const db = await getDb();
    expect(await db.get("audioFiles", hornId)).toBeDefined();
  });

  it("keeps a sound another profile's pad holds", async () => {
    // Show A owns the sound; the user adds the same file to a pad in Show B
    // and then cancels. Audio rows are global, so the reuse crosses profiles.
    const { id: sharedId } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn("horn.wav"),
    });
    const showA = await addProfile({ name: "Show A", syncType: "local" });
    await upsertPadConfiguration({
      profileId: showA,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      audioFileIds: [sharedId],
      playbackType: "sequential",
    });
    await addProfile({ name: "Show B", syncType: "local" });

    const { session } = await openEditor();
    await addSounds([horn("horn-under-another-name.wav")], 1);

    expect([...session.provisionalFileIds]).toEqual([sharedId]);

    await cancelEditor();

    const db = await getDb();
    expect(await db.get("audioFiles", sharedId)).toBeDefined();
  });

  it("still discards a sound this edit created, so cancelling leaves no orphan", async () => {
    // The other half. Keeping referenced rows must not turn into keeping
    // everything: a row nothing names is exactly what the discard is for.
    const { id: hornId } = await addOrReuseAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn("horn.wav"),
    });
    const profileId = await addProfile({
      name: "Only Show",
      syncType: "local",
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      audioFileIds: [hornId],
      playbackType: "sequential",
    });

    const { session } = await openEditor([hornId]);
    await addSounds([stab("stab.wav")], 2);

    const provisional = [...session.provisionalFileIds];
    expect(provisional).toHaveLength(1);
    // Different bytes must mean a different row, or this case would silently
    // become the reuse case above and prove nothing.
    expect(provisional[0]).not.toBe(hornId);

    await cancelEditor();

    const db = await getDb();
    expect(await db.get("audioFiles", provisional[0])).toBeUndefined();
    expect(await db.get("audioFiles", hornId)).toBeDefined();
  });
});
