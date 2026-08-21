import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  activatePad,
  bankTabs,
  createTestAudioFilePath,
  dragTabLeft,
  gotoApp,
  importBankArchive,
  openImportExportTab,
} from "./test-helpers";

/**
 * The "Export banks" section, in a browser, against a profile whose tabs have
 * been rearranged.
 *
 * The unit suite can see every argument this panel passes and can build any
 * bank arrangement it likes; two things it cannot do are what this file is
 * for. It cannot drag a tab — `@hello-pangea/dnd`'s sensors do not run under
 * jsdom, and this repo has shipped a bank-tab drag that passed three review
 * rounds of jsdom tests while not working in a browser at all. And it cannot
 * see a file arrive: the store action opens a save dialog or falls back to a
 * download, streams a real ZIP through it, and nothing about that exists
 * outside a browser.
 *
 * So the arrangement here is the one where position and identity come apart
 * for real. Bank 2 holds the only sound and is dragged to the front, which
 * makes it the bank at position 0 while its id is still the id of the second
 * bank. A panel that picked by position would then hand the exporter bank 1 —
 * empty, and named "Bank 1" — and every assertion below would notice: the
 * file would be named for the wrong bank, it would be a fraction of the size,
 * and importing it back would produce a bank with no sound in it.
 */

test.describe("Export banks", () => {
  test("exports the bank the user ticked, after its position has moved", async ({
    page,
  }) => {
    // Force the in-memory blob download fallback: the File System Access API
    // save dialog is native and cannot be driven from Playwright, while the
    // fallback surfaces as an ordinary download event.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });
    await gotoApp(page);

    // The one sound in the profile goes in bank 2, so "which bank did it
    // export" has an answer that survives every layer down to the bytes.
    const tabs = bankTabs(page);
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    const soundName = "bank-export-ui-sound";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(soundName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(soundName);

    // Now pull it to the front. Bank 2 is at position 0 from here on, while
    // its identity is still the second bank's.
    await dragTabLeft(page, 1);
    await expect(tabs.nth(0)).toHaveText("1: Bank 2");
    await expect(tabs.nth(1)).toHaveText("2: Bank 1");

    await openImportExportTab(page);

    // The panel numbers banks the way the board does. If these two ever
    // disagree, "the third one" means two different banks in one app.
    const options = page.locator('[data-testid="export-bank-option"]');
    await expect(options).toHaveCount(10);
    await expect(
      options.nth(0).locator('[data-testid="export-bank-label"]'),
    ).toHaveText("1: Bank 2");
    await expect(
      options.nth(0).locator('[data-testid="export-bank-summary"]'),
    ).toContainText("1 sound");
    await expect(
      options.nth(1).locator('[data-testid="export-bank-summary"]'),
    ).toContainText("Empty");

    await options
      .nth(0)
      .locator('[data-testid="export-bank-checkbox"]')
      .click();
    const exportButton = page.locator('[data-testid="export-selected-banks"]');
    await expect(exportButton).toHaveText("Export 1 Bank");

    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;

    // The filename is built from the bank NAME the panel passed alongside the
    // id, so this is the first place a mismatched pair would show.
    expect(download.suggestedFilename()).toBe(
      `impamp-bank-bank-2-${new Date().toISOString().split("T")[0]}.iaz`,
    );
    const archivePath = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "impamp-bank-ui-")),
      "banks.iaz",
    );
    await download.saveAs(archivePath);
    // Bank 1 is empty, so a positional pick would have produced a few hundred
    // bytes of JSON rather than an archive with a WAV in it.
    expect((await fs.promises.stat(archivePath)).size).toBeGreaterThan(10_000);

    // The selection is cleared once the file lands, so the button cannot be
    // pressed again on a set the user has already sent.
    await expect(exportButton).toHaveText("Export 0 Banks");
    await expect(exportButton).toBeDisabled();

    // And the strongest check: put it back. The name in the archive could
    // still have been right while the *id* was wrong — this is what tells
    // the two apart, because the pads come from the id.
    const written = await importBankArchive(page, archivePath, {
      "0": { kind: "add" },
    });
    expect(written).toEqual(["Bank 2"]);

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(tabs).toHaveCount(11);
    await expect(tabs.nth(10)).toHaveText("11: Bank 2");
    await tabs.nth(10).click();
    const importedPad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(importedPad).toContainText(soundName);
    await activatePad(page, importedPad);

    await fs.promises.rm(path.dirname(archivePath), {
      recursive: true,
      force: true,
    });
  });
});
