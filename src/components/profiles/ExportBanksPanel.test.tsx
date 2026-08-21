// @vitest-environment jsdom
/**
 * The Import / Export tab's "Export banks" panel.
 *
 * Picking the banks *is* this feature. Everything underneath it — the archive
 * writer, the store action, the placement dialog to come — takes a list of
 * bank **identities**, and this panel is the only place a human turns "the one
 * I called SFX, the second one" into that list. So the tests below are almost
 * all about the same question asked from different sides: does the id that
 * leaves this panel belong to the row the user actually ticked?
 *
 * Three traps are deliberately built into the fixture, because each has bitten
 * this branch family already:
 *
 *  1. **A position is not an identity.** No bank here sits at the position its
 *     id encodes, and two banks share a `pageIndex` so the order has to come
 *     out of `normaliseBankOrder` rather than out of the raw rows. A fixture
 *     built from `ensureDefaultBanks` cannot tell the two apart — every one of
 *     its banks has `bankId === String(pageIndex)`.
 *  2. **Bank names are not unique.** Two banks are called "SFX". Anything
 *     keyed on a name collides on them; the position prefix is what keeps the
 *     two rows apart, and one test ticks the second and watches the first stay
 *     home.
 *  3. **Pads are not the profile's pads.** A second profile holds a bank whose
 *     id is also "0", with pads of its own, so counting by bank id alone
 *     over-reports.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
// Type-only, so they are erased and cannot defeat the import ordering above.
import type { Profile } from "@/lib/db";
import type {
  TransferProgress,
  TransferProgressCallback,
} from "@/lib/importExport";

// `db.ts` fires a loudness analysis at every audio row it creates, and jsdom
// has no Web Audio for it to use.
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

/**
 * The real database, with one read the test can hold open.
 *
 * `vi.doMock` with a factory means `db.ts` is never evaluated a second time —
 * the factory hands back the very functions `importActual` loaded, so there is
 * still exactly one connection and one memoised `getDb`. Only the bank read
 * gains a gate, which is the only way to stand inside the turn of the event
 * loop where a profile has been chosen and its banks have not arrived.
 */
const realDb = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
let holdBankReads = false;
let releaseBankRead: (() => void) | null = null;
vi.doMock("@/lib/db", () => ({
  ...realDb,
  getAllPageMetadataForProfile: async (profileId: number) => {
    if (holdBankReads) {
      await new Promise<void>((resolve) => {
        releaseBankRead = resolve;
      });
    }
    return realDb.getAllPageMetadataForProfile(profileId);
  },
}));

const ExportBanksPanel = (
  await import("@/components/profiles/ExportBanksPanel")
).default;
const { addAudioFile, addProfile, upsertPadConfiguration, upsertPageMetadata } =
  realDb;

/** A bank id that is a minted UUID, as `createBank` writes one. */
const OPENERS = "f0b1c7de-4f3a-4d2f-9c1e-000000000001";
const STINGS = "f0b1c7de-4f3a-4d2f-9c1e-000000000002";

/**
 * The banks of the profile under test, in the order they are **written**.
 *
 * Three things are deliberate. Read the pairs as (identity, position): "0"
 * sits at 1, "9" at 2, "7" at 3 — not one of them sits where its id says,
 * which is the only arrangement that can tell identity-keyed code from
 * position-keyed code. `STINGS` shares position 3 with "7", because a merge is
 * allowed to leave two banks on one `pageIndex`, so the display order has to
 * be derived rather than read off. And the write order below is *not* the
 * display order, because `getAllPageMetadataForProfile` hands rows back in key
 * order: a fixture written in display order cannot tell "sorted properly"
 * from "read the array at that index".
 */
const BANKS: [
  bankId: string,
  pageIndex: number,
  name: string,
  isEmergency?: boolean,
][] = [
  ["0", 1, "SFX"],
  [STINGS, 3, "Stings"],
  ["9", 2, "SFX", true],
  [OPENERS, 0, "Openers"],
  ["7", 3, ""],
];

/** The display order the fixture above must produce. */
const DISPLAY_ORDER = [OPENERS, "0", "9", "7", STINGS];

let panel: MountedPanel;
let profileId: number;
let otherProfileId: number;
type ExportAction = (
  profileId: number,
  bankIds: string[],
  bankNames: string[],
  onProgress?: TransferProgressCallback,
) => Promise<boolean>;

let exportBanksToZip: ReturnType<typeof vi.fn<ExportAction>>;

async function sound(name: string): Promise<number> {
  // Distinct bytes per name: `addAudioFile` does not reuse, but a later reader
  // keyed on content would silently make two "different" sounds one row.
  return addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: new Blob([`the bytes of ${name}`, name.repeat(4)]),
  });
}

async function pad(
  onProfile: number,
  bankId: string,
  padIndex: number,
  audioFileIds: number[],
): Promise<void> {
  await upsertPadConfiguration({
    profileId: onProfile,
    bankId,
    padIndex,
    audioFileIds,
    playbackType: "sequential",
  });
}

/** Every bank row, in the order the panel rendered them. */
function rows(): HTMLElement[] {
  return panel.all("export-bank-option");
}

/** The row for a bank identity, whatever position it ended up at. */
function rowFor(bankId: string): HTMLElement {
  const found = rows().find((row) => row.dataset.bankId === bankId);
  if (!found) throw new Error(`no row for bank ${bankId}`);
  return found;
}

/** Ticks (or unticks) the checkbox of one bank, by identity. */
async function tick(bankId: string): Promise<void> {
  const box = rowFor(bankId).querySelector<HTMLInputElement>(
    '[data-testid="export-bank-checkbox"]',
  );
  if (!box) throw new Error(`no checkbox in the row for bank ${bankId}`);
  await panel.press(box);
}

/** The label text of every row, in order. */
function labels(): string[] {
  return rows().map((row) =>
    (
      row.querySelector('[data-testid="export-bank-label"]')?.textContent ?? ""
    ).trim(),
  );
}

/** The summary line of one bank's row. */
function summary(bankId: string): string {
  return (
    rowFor(bankId)
      .querySelector('[data-testid="export-bank-summary"]')
      ?.textContent?.trim() ?? ""
  );
}

/** Presses Export and lets the action settle. */
async function exportSelected(): Promise<void> {
  await panel.click("export-selected-banks");
}

/** The (bankIds, bankNames) pair the store action was handed. */
function exported(call = 0): { ids: string[]; names: string[] } {
  const args = exportBanksToZip.mock.calls[call];
  return { ids: args[1], names: args[2] };
}

function profileStub(id: number, name: string): Profile {
  return { id, name, syncType: "local" } as Profile;
}

beforeEach(async () => {
  holdBankReads = false;
  releaseBankRead = null;
  await clearAllStores();
  vi.clearAllMocks();

  profileId = await addProfile({ name: "Show A", syncType: "local" });
  otherProfileId = await addProfile({ name: "Show B", syncType: "local" });

  for (const [bankId, pageIndex, name, isEmergency] of BANKS) {
    await upsertPageMetadata({
      profileId,
      bankId,
      pageIndex,
      name,
      isEmergency: isEmergency ?? false,
    });
  }
  // Show B holds a bank whose id is also "0". Counting pads by bank id
  // without filtering by profile would fold these three into Show A's row.
  await upsertPageMetadata({
    profileId: otherProfileId,
    bankId: "0",
    pageIndex: 0,
    name: "Elsewhere",
  });

  const [alpha, bravo, charlie, delta] = [
    await sound("alpha"),
    await sound("bravo"),
    await sound("charlie"),
    await sound("delta"),
  ];
  // Openers: two sounding pads, three references, two distinct sounds — the
  // archive carries a shared sound once, and the summary has to agree with it
  // — plus a third pad somebody cleared, which is not a pad worth counting.
  await pad(profileId, OPENERS, 0, [alpha]);
  await pad(profileId, OPENERS, 1, [alpha, bravo]);
  await pad(profileId, OPENERS, 2, []);
  await pad(profileId, "0", 0, [charlie]);
  // "7" has a pad row with every sound cleared off it, which is what
  // clearing a pad leaves behind. It is still an empty bank.
  await pad(profileId, "7", 0, []);
  await pad(profileId, STINGS, 5, [delta]);
  // "9" has no pad rows at all: the other way for a bank to be empty.
  for (const padIndex of [0, 1, 2]) {
    await pad(otherProfileId, "0", padIndex, [alpha]);
  }

  exportBanksToZip = vi.fn<ExportAction>(async () => true);
  panel = await mountPanel(
    <ExportBanksPanel
      profiles={[
        profileStub(profileId, "Show A"),
        profileStub(otherProfileId, "Show B"),
      ]}
      activeProfileId={profileId}
      exportBanksToZip={exportBanksToZip}
    />,
  );
});

afterEach(async () => {
  await panel.unmount();
});

describe("the bank list", () => {
  it("numbers the banks the way the board's tabs do, by position", () => {
    expect(rows().map((row) => row.dataset.bankId)).toEqual(DISPLAY_ORDER);
    expect(labels()).toEqual([
      "1: Openers",
      "2: SFX",
      "3: SFX",
      "4: Unnamed bank",
      "5: Stings",
    ]);
  });

  it("counts the sounds a bank would carry, per sound and not per reference", () => {
    // Three pad rows, one of them cleared; three references across the other
    // two; two audio rows. The archive writes the shared sound once, so "3
    // sounds" would promise a bigger file, and "3 pads" would count a pad
    // that carries nothing.
    expect(summary(OPENERS)).toContain("2 pads");
    expect(summary(OPENERS)).toContain("2 sounds");
    expect(summary("0")).toContain("1 pad,");
    expect(summary("0")).toContain("1 sound");
  });

  it("says which banks are empty, whether they have no pads or only blank ones", () => {
    expect(summary("9")).toContain("Empty");
    expect(summary("7")).toContain("Empty");
    expect(summary(STINGS)).not.toContain("Empty");
  });

  it("marks an emergency bank, because that travels with it", () => {
    expect(summary("9")).toContain("Emergency bank");
    expect(summary(STINGS)).not.toContain("Emergency");
  });

  it("counts only this profile's pads", () => {
    // Show B's bank is also called "0" and holds three pads.
    expect(summary("0")).toContain("1 pad,");
  });

  it("says so when a profile has no banks", async () => {
    const emptyId = await addProfile({ name: "Show C", syncType: "local" });
    await panel.render(
      <ExportBanksPanel
        profiles={[profileStub(emptyId, "Show C")]}
        activeProfileId={emptyId}
        exportBanksToZip={exportBanksToZip}
      />,
    );

    expect(panel.required("bank-export-none").textContent).toContain(
      "no banks",
    );
    expect(rows()).toHaveLength(0);
    expect(panel.testId("bank-export-select-all")).toBeNull();
  });

  it("offers no banks at all while the chosen profile is still being read", async () => {
    // Standing inside the turn between "Show B is chosen" and "Show B's banks
    // have arrived". Show A's five rows are what was on screen a moment ago,
    // and every one of them would export a bank Show B does not contain.
    holdBankReads = true;
    await panel.setValue(
      panel.required("bank-export-profile"),
      String(otherProfileId),
    );

    expect(rows()).toHaveLength(0);
    expect(panel.required("bank-export-loading")).not.toBeNull();
    expect(panel.testId("bank-export-none")).toBeNull();
    // Nor is there a Select all to press. It would tick the five banks that
    // are no longer on screen and file them under the profile now chosen.
    expect(panel.testId("bank-export-select-all")).toBeNull();
    // The gate really did engage: without this the assertions above would
    // pass just as happily against a read that had already finished.
    expect(releaseBankRead).not.toBeNull();

    holdBankReads = false;
    releaseBankRead?.();
    await panel.settle();

    expect(rows().map((row) => row.dataset.bankId)).toEqual(["0"]);
  });
});

describe("selecting banks", () => {
  it("keeps two banks of the same name apart", async () => {
    await tick("9");
    await exportSelected();

    expect(exported().ids).toEqual(["9"]);
    expect(exported().names).toEqual(["SFX"]);
  });

  it("ticks the bank whose label was clicked, not the other one of that name", async () => {
    // A checkbox is a 16-pixel target; the label is how it is hit in
    // practice, and a label reaches its input through `htmlFor`. Key that id
    // on the name and the two banks called "SFX" share it, so the browser
    // hands every click on the second label to the first one's checkbox —
    // a failure invisible to a test that clicks the input directly.
    const label = rowFor("9").querySelector<HTMLElement>(
      '[data-testid="export-bank-label"]',
    );
    expect(label?.textContent).toContain("3: SFX");
    await panel.press(label!);

    await exportSelected();
    expect(exported().ids).toEqual(["9"]);
  });

  it("exports in board order, whatever order they were ticked", async () => {
    await tick(STINGS);
    await tick("0");
    await tick(OPENERS);
    await exportSelected();

    expect(exported().ids).toEqual([OPENERS, "0", STINGS]);
  });

  it("pairs every name with its own bank", async () => {
    await tick(OPENERS);
    await tick("7");
    await tick(STINGS);
    await exportSelected();

    const { ids, names } = exported();
    expect(ids).toEqual([OPENERS, "7", STINGS]);
    // "" is the unnamed bank's real name, and the filename rule downstream is
    // what decides what to call the file. Substituting the display fallback
    // here would put "Unnamed bank" inside the archive.
    expect(names).toEqual(["Openers", "", "Stings"]);
  });

  it("exports the profile that is selected, with that profile's banks", async () => {
    // "0", not Openers, and that is the whole point: Show B's only bank is
    // *also* called "0". A selection carried across as bare ids would land on
    // it, and a fixture that ticked an id Show B does not have could not tell.
    await tick("0");
    await tick(OPENERS);
    await panel.setValue(
      panel.required("bank-export-profile"),
      String(otherProfileId),
    );

    // The selection did not survive the switch. Note what Show B's one bank
    // is called: "0", the same id Show A's second bank has, because that is
    // the id `ensureDefaultBanks` gives every profile's first bank. A
    // selection held as bare ids would have arrived here already ticked.
    expect(rows().map((row) => row.dataset.bankId)).toEqual(["0"]);
    expect(
      rowFor("0").querySelector<HTMLInputElement>(
        '[data-testid="export-bank-checkbox"]',
      )?.checked,
    ).toBe(false);
    expect(panel.required("export-selected-banks").textContent).toContain(
      "(0)",
    );

    await tick("0");
    await exportSelected();
    expect(exportBanksToZip.mock.calls[0][0]).toBe(otherProfileId);
    expect(exported().names).toEqual(["Elsewhere"]);
  });

  it("will not export with nothing ticked", async () => {
    const button = panel.required("export-selected-banks") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("(0)");

    await exportSelected();
    expect(exportBanksToZip).not.toHaveBeenCalled();
  });

  it("selects every bank at once, and clears them again", async () => {
    await panel.click("bank-export-select-all");
    expect(panel.required("export-selected-banks").textContent).toContain(
      "(5)",
    );
    await exportSelected();
    expect(exported().ids).toEqual(DISPLAY_ORDER);

    await panel.click("bank-export-select-all");
    await panel.click("bank-export-clear");
    expect(
      (panel.required("export-selected-banks") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("lets an empty bank be exported, because a named empty bank is a thing to send", async () => {
    await tick("9");
    const button = panel.required("export-selected-banks") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await exportSelected();
    expect(exported().ids).toEqual(["9"]);
  });
});

describe("exporting", () => {
  it("clears the selection once a file was saved", async () => {
    await tick(OPENERS);
    await exportSelected();

    expect(panel.required("export-selected-banks").textContent).toContain(
      "(0)",
    );
  });

  it("keeps the selection when the save dialog was cancelled", async () => {
    exportBanksToZip.mockResolvedValue(false);
    await tick(OPENERS);
    await exportSelected();

    expect(panel.required("export-selected-banks").textContent).toContain(
      "(1)",
    );
    expect(panel.testId("bank-export-error")).toBeNull();
  });

  it("shows a failure in the panel rather than losing it to the console", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    exportBanksToZip.mockRejectedValue(new Error("Bank 9 not found"));
    await tick("9");
    await exportSelected();

    expect(panel.required("bank-export-error").textContent).toContain(
      "Bank 9 not found",
    );
    // And the selection is still there to try again with.
    expect(panel.required("export-selected-banks").textContent).toContain(
      "(1)",
    );
    consoleError.mockRestore();
  });

  it("shows progress while the audio streams, and cannot be pressed twice", async () => {
    let release: (saved: boolean) => void = () => {};
    exportBanksToZip.mockImplementation(
      (
        _profileId: number,
        _bankIds: string[],
        _names: string[],
        onProgress?: (progress: TransferProgress) => void,
      ) =>
        new Promise<boolean>((resolve) => {
          onProgress?.({
            phase: "audio",
            processedFiles: 0,
            totalFiles: 2,
            processedBytes: 50,
            totalBytes: 100,
            fileName: "alpha.wav",
          });
          release = resolve;
        }),
    );

    await tick(OPENERS);
    await exportSelected();

    expect(panel.required("transfer-progress").textContent).toContain("50%");
    const button = panel.required("export-selected-banks") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await exportSelected();
    expect(exportBanksToZip).toHaveBeenCalledTimes(1);

    await panel.press(button);
    release(true);
    await panel.settle();
    expect(panel.testId("transfer-progress")).toBeNull();
  });
});
