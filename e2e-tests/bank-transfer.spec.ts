import { test, expect } from "@playwright/test";
import * as fs from "fs";
import {
  activatePad,
  bankTabs,
  countAudioFiles,
  createAndSwitchToProfile,
  createTestAudioFilePath,
  dragTabLeft,
  expectNothingPlaying,
  gotoApp,
  openImportExportTab,
  openProfileManager,
} from "./test-helpers";

/**
 * Banks crossing from one profile to another, in a browser.
 *
 * Three specs already cover the halves of this. `bank-transfer-store.spec.ts`
 * proves the board is told after a write, `bank-export-ui.spec.ts` proves the
 * panel picks by identity rather than by position, and
 * `bank-import-ui.spec.ts` proves a real `.iaz` goes out through the panel and
 * comes back through the file input and the placement dialog. All three stay
 * inside one profile, and the feature exists to move banks *between* them —
 * which is where the audio library stops being incidental and becomes the
 * thing at risk.
 *
 * So this file covers what only a second profile can show:
 *
 * - a sound two banks share travels once and both banks still name it;
 * - a destination that already holds those bytes reuses its row rather than
 *   growing a second copy of the same audio;
 * - the profile the banks came from can then be deleted and the banks keep
 *   playing, because the row they point at is one the surviving profile
 *   references too;
 * - and an import that fails halfway leaves the destination exactly as it
 *   was — no bank added, no bank emptied, no audio row left behind.
 *
 * Neither test asserts anything the three existing specs already assert.
 */

/** The pad at `padIndex` in whichever bank is on screen. */
const padAt = (page: import("@playwright/test").Page, padIndex: number) =>
  page.locator(`[id^="pad-"][id$="-${padIndex}"]`);

/**
 * Drops a file onto the pad at `padIndex` and waits for its name to show.
 *
 * The drop is **re-issued** until it takes, for the same reason `activatePad`
 * re-issues its press: a single delivery is not guaranteed. `PadGrid` decides
 * per render whether a pad accepts a drop, and while that answer is still
 * settling — which it is for a few milliseconds after a profile switch — the
 * dropzone still fires and the handler returns without writing anything, and
 * without saying so. Measured, not assumed: the first drop into a
 * just-created profile was lost every run, and the same drop a few
 * milliseconds later took every run.
 *
 * Re-issuing is safe. A pad holding one sound takes a drop as a replacement,
 * so a second delivery of the same file rewrites the pad with the same single
 * sound it already had.
 */
async function dropOnPad(
  page: import("@playwright/test").Page,
  padIndex: number,
  filePath: string,
  soundName: string,
) {
  const input = page.locator(`[data-testid="pad-drop-input-${padIndex}"]`);
  await expect(async () => {
    await input.setInputFiles(filePath);
    await expect(padAt(page, padIndex)).toContainText(soundName, {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
}

/**
 * The blob download fallback, forced.
 *
 * The File System Access API save dialog is native and cannot be driven from
 * Playwright; the fallback surfaces as an ordinary download event.
 */
async function openWithBlobDownloads(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  await gotoApp(page);
}

/** Ticks the numbered export options and saves the archive to `to`. */
async function exportBanks(
  page: import("@playwright/test").Page,
  optionIndexes: number[],
  to: string,
) {
  const options = page.locator('[data-testid="export-bank-option"]');
  for (const index of optionIndexes) {
    await options
      .nth(index)
      .locator('[data-testid="export-bank-checkbox"]')
      .click();
  }
  const button = page.locator('[data-testid="export-selected-banks"]');
  await expect(button).toHaveText(`Export ${optionIndexes.length} Banks`);
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  await (await downloadPromise).saveAs(to);
}

/** Every entry name in a `.iaz`, read the way the app reads it. */
async function archiveEntryNames(archivePath: string): Promise<string[]> {
  const zipjs = await import("@zip.js/zip.js");
  const bytes = await fs.promises.readFile(archivePath);
  const reader = new zipjs.ZipReader(new zipjs.BlobReader(new Blob([bytes])));
  try {
    return (await reader.getEntries()).map((entry) => entry.filename);
  } finally {
    await reader.close();
  }
}

/** The parsed `banks/<folder>/bank.json` from a `.iaz`. */
async function readBankJson(
  archivePath: string,
  folder: string,
): Promise<{ audioFiles: { id: number }[] }> {
  const zipjs = await import("@zip.js/zip.js");
  const bytes = await fs.promises.readFile(archivePath);
  const reader = new zipjs.ZipReader(new zipjs.BlobReader(new Blob([bytes])));
  try {
    const entry = (await reader.getEntries()).find(
      (candidate) => candidate.filename === `banks/${folder}/bank.json`,
    );
    if (!entry || entry.directory) {
      throw new Error(`no bank.json in folder ${folder}`);
    }
    return JSON.parse(await entry.getData(new zipjs.TextWriter()));
  } finally {
    await reader.close();
  }
}

/**
 * Breaks one entry of a zip so that reading *its* bytes fails and nothing
 * else does.
 *
 * The central directory is untouched, so the archive still lists its entries
 * and its manifest and every `bank.json` still parse — the import gets all
 * the way to fetching this one sound's blob before anything goes wrong, which
 * is the only shape that can leave a multi-bank import half applied.
 *
 * The local file header's signature is what gets flipped rather than the
 * payload, because zip.js does not verify CRC-32 on read by default: a
 * corrupted *body* is handed back intact (measured, not assumed), while a
 * corrupted local header raises "Local file header not found".
 *
 * @param archive The archive bytes
 * @param entryName The entry whose local header to break
 * @returns A copy with that one header broken
 */
function breakEntryHeader(archive: Buffer, entryName: string): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const LOCAL_HEADER_SIGNATURE = 0x04034b50;
  for (let at = 0; (at = archive.indexOf(name, at)) !== -1; at++) {
    const header = at - 30;
    if (header < 0) continue;
    if (archive.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) continue;
    // `audio/1` is a prefix of `audio/12`, so the header's own name length is
    // what says this is the entry asked for rather than one named after it.
    if (archive.readUInt16LE(header + 26) !== name.length) continue;
    const broken = Buffer.from(archive);
    broken.writeUInt32LE(LOCAL_HEADER_SIGNATURE + 1, header);
    return broken;
  }
  throw new Error(`no local file header for ${entryName}`);
}

/**
 * Deletes the one profile that is not the active one.
 *
 * The button only exists on a profile that is not in use, so a two-profile
 * manager offers exactly one — and `window.confirm` is what guards it, which
 * Playwright dismisses unless something says otherwise.
 *
 * Leaves the manager open: both callers have more to do in it.
 */
async function deleteTheOtherProfile(page: import("@playwright/test").Page) {
  page.on("dialog", (confirmation) => confirmation.accept());
  await openProfileManager(page);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Default Local Profile" }),
  ).toHaveCount(0);
}

test.describe("Banks between profiles", () => {
  test("a shared sound crosses once, and outlives the profile it came from", async ({
    page,
  }, testInfo) => {
    await openWithBlobDownloads(page);

    const tabs = bankTabs(page);
    // Ten seconds rather than the helper's default minute: two of these go
    // into an archive that is written, read back by this process, and pushed
    // through a file input, and STORE-d audio is the whole of its size.
    const opener = await createTestAudioFilePath("roundtrip-opener", 10);
    const outro = await createTestAudioFilePath("roundtrip-outro", 10);

    // Bank 1 opens with the sting. Bank 2 opens with the same one — the same
    // file, so the same bytes, so one row: that is the sound whose travelling
    // once is the point of the archive's shared `audio/` folder.
    await tabs.nth(0).click();
    await dropOnPad(page, 0, opener, "roundtrip-opener");
    await tabs.nth(1).click();
    await dropOnPad(page, 0, opener, "roundtrip-opener");
    await dropOnPad(page, 1, outro, "roundtrip-outro");
    expect(await countAudioFiles(page)).toBe(2);

    // Pull Bank 2 to the front, so the two banks being exported sit at
    // positions 0 and 1 while their identities are the second and the first
    // bank's. A positional export would then put Bank 1's single pad in the
    // archive's first folder, which every count below would notice.
    await dragTabLeft(page, 1);
    await expect(tabs.nth(0)).toHaveText("1: Bank 2");
    await expect(tabs.nth(1)).toHaveText("2: Bank 1");

    await openImportExportTab(page);
    const archivePath = testInfo.outputPath("two-banks.iaz");
    await exportBanks(page, [0, 1], archivePath);

    // Three pad references to two sounds, and the sting is the one both banks
    // name. It is in the archive once — the `audio/` folder is shared across
    // every bank, keyed by the exporting device's row id — and *both* banks
    // still declare it, which is the half that can silently go missing: an
    // archive whose second bank lists only the sounds the first did not
    // reads perfectly well and arrives one sound short.
    const names = await archiveEntryNames(archivePath);
    const audioEntries = names.filter((name) => name.startsWith("audio/"));
    expect(audioEntries).toHaveLength(2);
    // Both banks are in there at all. An export that stopped one short reads
    // as a missing folder several assertions later, which says nothing about
    // where it went wrong.
    expect(names).toContain("banks/0/bank.json");
    expect(names).toContain("banks/1/bank.json");
    const declared = await Promise.all(
      ["0", "1"].map(async (folder) =>
        (await readBankJson(archivePath, folder)).audioFiles.map(
          (file) => `audio/${file.id}`,
        ),
      ),
    );
    expect(declared[0].sort()).toEqual(audioEntries.sort());
    expect(declared[1]).toHaveLength(1);
    expect(audioEntries).toContain(declared[1][0]);

    await page.getByLabel("Close").click();
    await createAndSwitchToProfile(page, "Touring Rig");

    // The destination already has the sting, dropped in by hand rather than
    // imported. Still two rows in the library: identical bytes are one row
    // whichever profile put them there, which is what makes the import's
    // reuse below a reuse rather than a first arrival.
    await dropOnPad(page, 0, opener, "roundtrip-opener");
    expect(await countAudioFiles(page)).toBe(2);

    await openImportExportTab(page);
    await page
      .getByTestId("import-profile-file-input")
      .setInputFiles(archivePath);
    const dialog = page.getByTestId("bank-import-dialog");
    await expect(dialog).toBeVisible();

    // Which folder holds which bank, by what is in it rather than by its
    // name: both profiles call their first two banks "Bank 1" and "Bank 2",
    // so the pad and sound counts are the only tell that the export followed
    // the board's order and not the store's.
    const rows = dialog.getByTestId("bank-import-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByTestId("bank-import-name")).toHaveText(
      "1: Bank 2",
    );
    await expect(rows.nth(0).getByTestId("bank-import-summary")).toHaveText(
      "2 pads, 2 sounds",
    );
    await expect(rows.nth(1).getByTestId("bank-import-summary")).toHaveText(
      "1 pad, 1 sound",
    );

    // Both as new banks. The archive's `sourceBankId`s are "1" and "0", which
    // this profile's default banks answer to as well, so the dialog opens on
    // a replace of them — the ids match because every profile's banks are
    // numbered from "0", not because these are the same banks.
    for (const folder of ["0", "1"]) {
      const placement = page.getByTestId(`bank-placement-${folder}`);
      await expect(placement).toHaveValue(/^replace:/);
      await placement.selectOption("add");
    }
    await expect(rows.nth(0).getByTestId("bank-import-consequence")).toHaveText(
      "Added as a new bank. Nothing already in Touring Rig changes.",
    );

    await page.getByRole("button", { name: "Import 2 Banks" }).click();
    await expect(page.getByTestId("bank-import-result")).toContainText(
      "Imported 2 banks into Touring Rig",
    );

    // The sting arrived by being recognised, not by being added: two rows
    // before, two rows after, for an archive carrying a sound this device
    // already had and one it did not.
    expect(await countAudioFiles(page)).toBe(2);

    await page.getByRole("button", { name: "Done" }).click();
    await page.getByLabel("Close").click();

    await expect(tabs).toHaveCount(12);
    await expect(tabs.nth(10)).toHaveText("11: Bank 2");
    await expect(tabs.nth(11)).toHaveText("12: Bank 1");
    await tabs.nth(10).click();
    await expect(padAt(page, 0)).toContainText("roundtrip-opener");
    await expect(padAt(page, 1)).toContainText("roundtrip-outro");
    await activatePad(page, padAt(page, 1));
    // Silence first. `activatePad` returns straight away if anything at all is
    // already playing, so a sound left running from the pad above would let
    // the next call pass without ever pressing the pad it was given.
    await page.keyboard.press("Escape");
    await expectNothingPlaying(page);

    // Now throw away the profile the banks came from. Every sound these banks
    // play is a row that profile created, and it is the only profile that
    // ever wrote one — so "delete the audio this profile referenced" and
    // "delete the audio nothing else references" are two different answers
    // here, and only one of them leaves a working board.
    await deleteTheOtherProfile(page);
    expect(await countAudioFiles(page)).toBe(2);

    await page.getByLabel("Close").click();
    await expect(tabs.nth(10)).toHaveText("11: Bank 2");
    await tabs.nth(10).click();
    await expect(padAt(page, 0)).toContainText("roundtrip-opener");
    await activatePad(page, padAt(page, 0));
  });

  test("an import that fails halfway leaves the destination as it was", async ({
    page,
  }, testInfo) => {
    await openWithBlobDownloads(page);

    const tabs = bankTabs(page);
    const keeper = await createTestAudioFilePath("rollback-keeper", 10);
    const doomed = await createTestAudioFilePath("rollback-doomed", 10);

    await tabs.nth(0).click();
    await dropOnPad(page, 0, keeper, "rollback-keeper");
    await tabs.nth(1).click();
    await dropOnPad(page, 0, doomed, "rollback-doomed");

    await openProfileManager(page);
    await page.getByRole("button", { name: "Import / Export" }).click();
    const archivePath = testInfo.outputPath("two-banks.iaz");
    await exportBanks(page, [0, 1], archivePath);
    await page.getByLabel("Close").click();

    await createAndSwitchToProfile(page, "Rollback Rig");
    const bystander = await createTestAudioFilePath("rollback-bystander", 10);
    await dropOnPad(page, 0, bystander, "rollback-bystander");

    // The source profile goes, so the archive's two sounds are genuinely new
    // to this device and the import has to create rows for them. Otherwise it
    // would reuse the ones the source profile left behind, and "the failed
    // import cleaned up after itself" would be indistinguishable from "it
    // never wrote anything".
    await deleteTheOtherProfile(page);
    expect(await countAudioFiles(page)).toBe(1);

    // Break the second bank's sound, and only it. The first bank imports
    // cleanly and is written before anything can go wrong, which is exactly
    // the half-applied state the all-or-nothing rule exists to prevent.
    const secondBank = await readBankJson(archivePath, "1");
    const brokenPath = testInfo.outputPath("two-banks-broken.iaz");
    await fs.promises.writeFile(
      brokenPath,
      breakEntryHeader(
        await fs.promises.readFile(archivePath),
        `audio/${secondBank.audioFiles[0].id}`,
      ),
    );

    await page.getByRole("button", { name: "Import / Export" }).click();
    await page
      .getByTestId("import-profile-file-input")
      .setInputFiles(brokenPath);
    const dialog = page.getByTestId("bank-import-dialog");
    await expect(dialog).toBeVisible();

    // The first bank over the bank that holds the bystander — so the
    // destination bank is emptied before the second bank can fail — and the
    // second as an addition, so a rollback that forgot it would leave an
    // eleventh tab behind.
    await page
      .getByTestId("bank-placement-0")
      .selectOption({ label: "Replace 1: Bank 1" });
    await page.getByTestId("bank-placement-1").selectOption("add");

    await page.getByRole("button", { name: "Import 2 Banks" }).click();
    await expect(page.getByTestId("bank-import-error")).toContainText(
      "could not be imported",
    );
    await expect(page.getByTestId("bank-import-result")).toHaveCount(0);

    // Nothing was added, and the row the successful first bank created is
    // gone with it: one sound in the library, the bystander's.
    expect(await countAudioFiles(page)).toBe(1);

    await page.getByTestId("cancel-bank-import").click();
    await page.getByLabel("Close").click();

    await expect(tabs).toHaveCount(10);
    await expect(tabs.nth(0)).toHaveText("1: Bank 1");
    await tabs.nth(0).click();
    // The bank the import emptied is back, pad for pad, with the sound it had
    // before rather than the one the import put there.
    await expect(padAt(page, 0)).toContainText("rollback-bystander");
    await expect(page.getByText("rollback-keeper")).toHaveCount(0);
    await activatePad(page, padAt(page, 0));
  });
});
