// @vitest-environment jsdom
/**
 * The placement dialog: where each bank of an archive goes.
 *
 * This is the last gate before an irreversible write, and it is the only
 * place in the bank-transfer feature where "replace that one" becomes a bank
 * **identity**. Nothing below it can tell that the wrong bank was named: the
 * importer clears whatever `bankId` it is handed and writes the incoming bank
 * over it.
 *
 * The fixture is built so that every way of getting that wrong is visible:
 *
 *  1. **A position is not an identity.** No bank in the destination sits at
 *     the position its id encodes, and the write order is not the display
 *     order — `getAllPageMetadataForProfile` hands rows back in key order, so
 *     a fixture written in board order cannot tell "sorted" from "read the
 *     array at that index".
 *  2. **Names are not unique, on either side.** The destination holds two
 *     banks called "SFX" (one empty, one not) and the archive carries two
 *     banks called "SFX". Anything keyed on a name collides, and only a test
 *     that picks by the *label* can see it.
 *  3. **A folder is not an array index.** The archive's folders are "0", "3"
 *     and "7", so placement state keyed by the row's position in the list
 *     would put the answers under the wrong keys.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
// Type-only, so they are erased and cannot defeat the import ordering above.
import type {
  BankImportResult,
  BankPlacement,
  BankSummary,
} from "@/lib/bankTransfer";
import type { TransferProgressCallback } from "@/lib/importExport";

// `db.ts` fires a loudness analysis at every audio row it creates, and jsdom
// has no Web Audio for it to use.
vi.doMock("@/lib/audio/loudness/pipeline", () => ({
  analyseAndStore: vi.fn(async () => null),
}));

const {
  MAX_BANKS,
  addAudioFile,
  addProfile,
  upsertPadConfiguration,
  upsertPageMetadata,
} = await import("@/lib/db");
const BankImportPlacementDialog = (
  await import("@/components/profiles/BankImportPlacementDialog")
).default;

/** Bank ids that are minted UUIDs, as `createBank` writes them. */
const OPENERS = "aa11bb22-cc33-dd44-ee55-000000000001";
const STINGS = "aa11bb22-cc33-dd44-ee55-000000000002";

/**
 * The destination profile's banks, in the order they are **written**.
 *
 * Read the pairs as (identity, position): the UUID sits at 0, "9" at 1, "0"
 * at 2, the other UUID at 3. Not one of them sits where its id says, which is
 * the only arrangement that tells identity-keyed code from position-keyed
 * code — every bank of a profile built by `ensureDefaultBanks` has
 * `bankId === String(pageIndex)`, and under such a fixture the two are the
 * same answer.
 */
const DESTINATION_BANKS: [bankId: string, pageIndex: number, name: string][] = [
  ["0", 2, "SFX"],
  [STINGS, 3, "Stings"],
  ["9", 1, "SFX"],
  [OPENERS, 0, "Openers"],
];

/** What each bank of the destination is called in the dialog, in order. */
const REPLACE_LABELS = [
  "Replace 1: Openers",
  "Replace 2: SFX",
  "Replace 3: SFX",
  "Replace 4: Stings",
];

/**
 * The archive, as `readArchiveManifest` describes one.
 *
 * "Stings" claims to have come from this very profile, which is the case the
 * default exists for. The two "SFX" banks share a name and nothing else: one
 * says it came from somewhere with no such bank, the other declines to say.
 */
const ARCHIVE_BANKS: BankSummary[] = [
  {
    folder: "0",
    name: "Stings",
    isEmergency: false,
    padCount: 3,
    audioCount: 4,
    sourceProfileName: "Last season",
    sourceBankId: STINGS,
  },
  {
    folder: "3",
    name: "SFX",
    isEmergency: false,
    padCount: 1,
    audioCount: 1,
    sourceProfileName: "Last season",
    sourceBankId: "b7c9-not-a-bank-here",
  },
  {
    folder: "7",
    name: "SFX",
    isEmergency: true,
    padCount: 0,
    audioCount: 0,
    sourceProfileName: "Last season",
    sourceBankId: "",
  },
];

type ImportAction = (
  file: Blob,
  profileId: number,
  placements: Record<string, BankPlacement>,
  onProgress?: TransferProgressCallback,
) => Promise<BankImportResult>;

let panel: MountedPanel;
let profileId: number;
let elsewhereId: number;
let importBanksFromArchive: ReturnType<typeof vi.fn<ImportAction>>;
let onBusyChange: ReturnType<typeof vi.fn<(busy: boolean) => void>>;
let onDismiss: ReturnType<typeof vi.fn<() => void>>;
const archiveFile = new Blob(["not really a zip"]);

/** A sound whose bytes are its own, so no two rows can collapse into one. */
async function sound(name: string): Promise<number> {
  return addAudioFile({
    name: `${name}.wav`,
    type: "audio/wav",
    blob: new Blob([`the bytes of ${name}`, name.repeat(3)]),
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

/** Mounts the dialog against whatever the database now holds. */
async function open(): Promise<void> {
  panel = await mountPanel(
    <BankImportPlacementDialog
      archive={{ file: archiveFile, banks: ARCHIVE_BANKS }}
      profileId={profileId}
      profileName="Roadshow"
      importBanksFromArchive={importBanksFromArchive}
      onBusyChange={onBusyChange}
      onDismiss={onDismiss}
    />,
  );
}

/** The dropdown for one archive folder. */
function select(folder: string): HTMLSelectElement {
  return panel.required(`bank-placement-${folder}`) as HTMLSelectElement;
}

/** The visible text of every option of one dropdown, in order. */
function optionLabels(folder: string): string[] {
  return [...select(folder).options].map((option) =>
    (option.textContent ?? "").trim(),
  );
}

/** Chooses an option by the words on it, the way a person does. */
async function choose(folder: string, label: string): Promise<void> {
  const dropdown = select(folder);
  const option = [...dropdown.options].find(
    (candidate) => (candidate.textContent ?? "").trim() === label,
  );
  if (!option) {
    throw new Error(
      `no option "${label}" for folder ${folder}; saw ${optionLabels(folder).join(" | ")}`,
    );
  }
  await panel.setValue(dropdown, option.value);
}

/** What one row says will happen to the destination. */
function consequence(folder: string): string {
  const row = panel
    .all("bank-import-row")
    .find((candidate) => candidate.dataset.folder === folder);
  if (!row) throw new Error(`no row for folder ${folder}`);
  return (
    row
      .querySelector('[data-testid="bank-import-consequence"]')
      ?.textContent?.trim() ?? ""
  );
}

/** The Import button, whatever it currently says. */
function importButton(): HTMLButtonElement {
  return panel.required("confirm-bank-import") as HTMLButtonElement;
}

/** The placement map the store action was handed. */
function placementsSent(call = 0): Record<string, BankPlacement> {
  return importBanksFromArchive.mock.calls[call][2];
}

/** The blocking problem the dialog is showing, if any. */
function problem(): string {
  return panel.testId("bank-import-problem")?.textContent?.trim() ?? "";
}

/** Adds banks until the profile holds `total` of them. */
async function fillTo(total: number): Promise<void> {
  for (let index = DESTINATION_BANKS.length; index < total; index++) {
    await upsertPageMetadata({
      profileId,
      bankId: `filler-${index}`,
      pageIndex: 10 + index,
      name: `Filler ${index}`,
      isEmergency: false,
    });
  }
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();

  profileId = await addProfile({ name: "Roadshow", syncType: "local" });
  elsewhereId = await addProfile({ name: "Elsewhere", syncType: "local" });

  for (const [bankId, pageIndex, name] of DESTINATION_BANKS) {
    await upsertPageMetadata({
      profileId,
      bankId,
      pageIndex,
      name,
      isEmergency: false,
    });
  }
  // Another profile holds a bank whose id is also "0", with pads of its own.
  // Counting pads by bank id alone would fold these into the row above.
  await upsertPageMetadata({
    profileId: elsewhereId,
    bankId: "0",
    pageIndex: 0,
    name: "Elsewhere",
    isEmergency: false,
  });

  const [alpha, bravo, charlie] = [
    await sound("alpha"),
    await sound("bravo"),
    await sound("charlie"),
  ];
  // "0" is the SFX bank with something in it: two pads naming two sounds,
  // plus a pad somebody cleared, which is not a pad worth warning about.
  await pad(profileId, "0", 0, [alpha]);
  await pad(profileId, "0", 1, [bravo]);
  await pad(profileId, "0", 2, []);
  // "9" is the other SFX bank, and it is empty — the two have to be
  // distinguishable by more than their name.
  await pad(profileId, OPENERS, 0, [charlie]);
  await pad(profileId, STINGS, 4, [alpha, bravo]);
  await pad(elsewhereId, "0", 0, [alpha]);

  importBanksFromArchive = vi.fn<ImportAction>(async () => ({
    written: [],
    skipped: [],
  }));
  onBusyChange = vi.fn<(busy: boolean) => void>();
  onDismiss = vi.fn<() => void>();
  await open();
});

afterEach(async () => {
  await panel.unmount();
});

describe("BankImportPlacementDialog", () => {
  it("starts a bank on a replace of the bank it came from, by identity", async () => {
    // "Stings" says it came from the bank whose id is STINGS, which this
    // profile still holds — the "I edited this and want it back" case.
    expect(select("0").value).toBe(`replace:${STINGS}`);
    // Neither "SFX" matches anything, even though the profile holds two banks
    // of that name. A default that matched on the name would land on one of
    // them and quietly delete it.
    expect(select("3").value).toBe("add");
    expect(select("7").value).toBe("add");
  });

  it("gives every incoming bank a name of its own", async () => {
    const names = ARCHIVE_BANKS.map(
      (bank) => select(bank.folder).getAttribute("aria-label") ?? "",
    );
    expect(new Set(names).size).toBe(names.length);
    // Two of these banks are called "SFX", so the number is the only thing
    // between them for anyone reading the page rather than looking at it.
    expect(names[1]).toContain("bank 2");
    expect(names[1]).toContain("SFX");
    expect(names[2]).toContain("bank 3");
  });

  it("keeps each row's answer under its own folder", async () => {
    await choose("7", "Skip this bank");

    expect(select("7").value).toBe("skip");
    // The other "SFX" is untouched, and so is the row whose folder is not its
    // position in the list.
    expect(select("3").value).toBe("add");
    expect(select("0").value).toBe(`replace:${STINGS}`);
  });

  it("offers the profile's banks in board order, numbered like the board", async () => {
    expect(optionLabels("3")).toEqual([
      "Add as a new bank",
      ...REPLACE_LABELS,
      "Skip this bank",
    ]);
  });

  it("replaces the bank behind the label, not the first one of that name", async () => {
    // "3: SFX" is the bank whose id is "0" and whose position is 2. Picking
    // it by the words on the option is the only way to catch a value keyed on
    // the name: both SFX options read the same without the number, and the
    // first one wins.
    await choose("0", "Replace 3: SFX");
    await panel.press(importButton());

    expect(placementsSent()["0"]).toEqual({ kind: "replace", bankId: "0" });
  });

  it("says what a replace deletes, and what it does not", async () => {
    await choose("0", "Replace 3: SFX");
    expect(consequence("0")).toBe(
      "Deletes everything in 3: SFX (2 pads, 2 sounds), and cannot be undone.",
    );

    // The other SFX bank holds nothing, and saying so is the difference
    // between a warning worth reading and one everybody clicks through.
    await choose("0", "Replace 2: SFX");
    expect(consequence("0")).toBe("2: SFX is empty, so nothing is lost.");

    await choose("0", "Add as a new bank");
    expect(consequence("0")).toBe(
      "Added as a new bank. Nothing already in Roadshow changes.",
    );

    await choose("0", "Skip this bank");
    expect(consequence("0")).toBe("Not imported.");
  });

  it("counts the profile's free slots before letting the import start", async () => {
    await panel.unmount();
    await fillTo(MAX_BANKS - 2);
    await open();

    await choose("0", "Add as a new bank");
    expect(importButton().disabled).toBe(true);
    expect(problem()).toBe(
      `Roadshow holds ${MAX_BANKS - 2} of ${MAX_BANKS} banks, so there is room for 2 more. ` +
        "3 banks here are set to be added — change at least 1 of them to Replace or Skip.",
    );

    await choose("7", "Skip this bank");
    expect(problem()).toBe("");
    expect(importButton().disabled).toBe(false);
    expect(importButton().textContent).toBe("Import 2 Banks");
  });

  it("refuses two banks aimed at the same bank", async () => {
    await choose("3", "Replace 4: Stings");

    expect(importButton().disabled).toBe(true);
    expect(problem()).toBe(
      "Two of these banks are set to replace 4: Stings, and the second would " +
        "overwrite the first. Choose a different bank, or Skip, for one of them.",
    );

    await choose("3", "Replace 3: SFX");
    expect(problem()).toBe("");
    expect(importButton().disabled).toBe(false);
  });

  it("hands the whole placement map over in one go", async () => {
    await choose("3", "Replace 1: Openers");
    await choose("7", "Skip this bank");
    await panel.press(importButton());

    expect(importBanksFromArchive).toHaveBeenCalledTimes(1);
    const [file, id, placements] = importBanksFromArchive.mock.calls[0];
    expect(file).toBe(archiveFile);
    expect(id).toBe(profileId);
    expect(placements).toEqual({
      "0": { kind: "replace", bankId: STINGS },
      "3": { kind: "replace", bankId: OPENERS },
      "7": { kind: "skip" },
    });
  });

  it("reports what was written once, and cannot be pressed again", async () => {
    importBanksFromArchive.mockResolvedValue({
      written: [
        { folder: "0", name: "Stings", bankId: STINGS, pageIndex: 3 },
        { folder: "3", name: "SFX", bankId: "new-one", pageIndex: 4 },
      ],
      skipped: ["SFX"],
    });
    await panel.press(importButton());

    const result = panel.required("bank-import-result").textContent ?? "";
    expect(result).toContain("Imported 2 banks into Roadshow");
    expect(result).toContain("Stings");
    expect(result).toContain("1 bank in the file was skipped");
    expect(panel.testId("confirm-bank-import")).toBeNull();
    expect(panel.testId("bank-placement-0")).toBeNull();

    await panel.click("dismiss-bank-import");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not start a second import while the first is running", async () => {
    let finish: (result: BankImportResult) => void = () => {};
    importBanksFromArchive.mockImplementation(
      () =>
        new Promise<BankImportResult>((resolve) => {
          finish = resolve;
        }),
    );

    await panel.press(importButton());
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toBe("Importing…");
    await panel.press(importButton());
    expect(importBanksFromArchive).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    finish({ written: [], skipped: [] });
    await panel.settle();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("says the profile is unchanged when the import fails", async () => {
    importBanksFromArchive.mockRejectedValue(
      new Error("Bank “Stings” could not be written."),
    );
    await panel.press(importButton());

    const error = panel.required("bank-import-error").textContent ?? "";
    expect(error).toContain("Bank “Stings” could not be written.");
    // All-or-nothing is the layer below's promise, and this is the only place
    // it is ever said to the person who pressed the button.
    expect(error).toContain("Nothing was imported, and Roadshow is unchanged");
    // The choices are still there to be corrected and tried again.
    expect(select("0").value).toBe(`replace:${STINGS}`);
    expect(importButton().disabled).toBe(false);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("has nothing to do when every bank is skipped", async () => {
    for (const bank of ARCHIVE_BANKS)
      await choose(bank.folder, "Skip this bank");

    expect(importButton().textContent).toBe("Import 0 Banks");
    expect(importButton().disabled).toBe(true);
    await panel.press(importButton());
    expect(importBanksFromArchive).not.toHaveBeenCalled();
  });

  it("warns that the set travels together and that a replace is final", async () => {
    const warning = panel.required("bank-import-warning").textContent ?? "";
    expect(warning).toContain("all or nothing");
    expect(warning).toContain("no undo");
    expect(panel.required("bank-import-target").textContent).toContain(
      "Roadshow",
    );
  });

  it("cancels without writing anything", async () => {
    await panel.click("cancel-bank-import");

    expect(importBanksFromArchive).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
