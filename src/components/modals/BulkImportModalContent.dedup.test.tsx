// @vitest-environment jsdom
/**
 * Bulk import: a folder of sounds dropped onto a bank in one go.
 *
 * The path that makes duplicates fastest. A folder holding a sting under two
 * names — `horn.wav` and the `horn (1).wav` a browser download made — stored
 * the bytes twice, and a second import of the same folder onto another bank
 * stored every one of them again.
 *
 * Its own fixture, driven through the real component: the write is inside a
 * click handler and there is nothing else to call.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `db.ts` fires a loudness analysis at every row it creates, and jsdom has no
// Web Audio for it to use.
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

const requestSync = vi.fn();
vi.doMock("@/store/profileStore", () => ({
  useProfileStore: { getState: () => ({ requestSync }) },
}));

const BulkImportModalContent = (
  await import("@/components/modals/BulkImportModalContent")
).default;
const { getDb, getPadConfigurationsForProfileBank } = await import("@/lib/db");

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ID = 1;
const BANK_ID = "0";

/** The same bytes every time, under whatever name. */
function horn(name: string): File {
  return new File(["the horn bytes"], name, { type: "audio/wav" });
}

let container: HTMLDivElement;
let root: Root;

/** The button whose label starts with this text, failing loudly if absent. */
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}

/** Hands the picker these files and waits for the list to show them. */
async function chooseFiles(files: File[]): Promise<void> {
  const input =
    container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * Clicks Save and waits for the writes it starts.
 *
 * The handler writes to IndexedDB, whose callbacks are events rather than
 * microtasks, so `act` alone returns while the first write is still in
 * flight.
 */
async function save(expectedPads: number): Promise<void> {
  await act(async () => {
    button("Save Assignments").click();
    for (let tick = 0; tick < 100; tick++) {
      const pads = await getPadConfigurationsForProfileBank(
        PROFILE_ID,
        BANK_ID,
      );
      if (pads.length >= expectedPads) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <BulkImportModalContent
        profileId={PROFILE_ID}
        bankId={BANK_ID}
        existingPadConfigs={new Map()}
        onAssignmentComplete={() => {}}
      />,
    );
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("saving a bulk import", () => {
  it("points both pads at one row when two files hold the same bytes", async () => {
    await chooseFiles([horn("horn.wav"), horn("horn (1).wav")]);
    await act(async () => {
      button("Auto-Assign").click();
    });

    await save(2);

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);

    const pads = await getPadConfigurationsForProfileBank(PROFILE_ID, BANK_ID);
    expect(pads).toHaveLength(2);
    expect(pads.map((pad) => pad.audioFileIds)).toEqual([
      [rows[0].id],
      [rows[0].id],
    ]);
  });

  it("stores a row per sound when the bytes differ", async () => {
    // The other half: reuse must not collapse two sounds into one row.
    await chooseFiles([
      horn("horn.wav"),
      new File(["a completely different stab"], "stab.wav", {
        type: "audio/wav",
      }),
    ]);
    await act(async () => {
      button("Auto-Assign").click();
    });

    await save(2);

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(2);
    const pads = await getPadConfigurationsForProfileBank(PROFILE_ID, BANK_ID);
    expect(new Set(pads.map((pad) => pad.audioFileIds[0])).size).toBe(2);
  });
});
