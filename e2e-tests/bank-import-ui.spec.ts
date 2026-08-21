import { test, expect } from "@playwright/test";
import {
  activatePad,
  bankTabs,
  createTestAudioFilePath,
  gotoApp,
  keyboardDragTab,
  latchEditMode,
  openProfileManager,
  unlatchEditMode,
} from "./test-helpers";

/**
 * The bank import placement dialog, in a browser, against a rearranged board.
 *
 * The unit suite can see every argument this dialog passes and can build any
 * arrangement of banks it likes. Three things it cannot do are what this file
 * is for. It cannot drag a tab — `@hello-pangea/dnd`'s sensors do not run
 * under jsdom, and this repo has shipped a bank-tab drag that passed three
 * review rounds of jsdom tests while not working in a browser at all. It
 * cannot make a real archive arrive through a file input, so the export and
 * the import are never proved to be two halves of one thing. And it cannot
 * see the board notice: the tabs, the pad grid and the keyboard listener all
 * refresh off `padConfigsVersion`, and dropping that bump leaves every unit
 * test green while the imported bank never appears.
 *
 * The arrangement is the one where position and identity come apart. Bank 3
 * is dragged to position 1, so the bank the user picks as "2: Bank 3" is the
 * third row in storage. Bank 1 — the only other bank with a sound in it — is
 * exported and then imported back *over* Bank 3. Everything asserted
 * afterwards distinguishes that from the two ways of getting it wrong: a
 * replace aimed by position would empty Bank 2, and an add would leave both
 * banks alone and give the profile an eleventh.
 */

test.describe("Import banks", () => {
  test("replaces the bank the user named, after its position has moved", async ({
    page,
  }, testInfo) => {
    // Force the in-memory blob download fallback: the File System Access API
    // save dialog is native and cannot be driven from Playwright.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });
    await gotoApp(page);

    const tabs = bankTabs(page);
    const padZero = page.locator('[id^="pad-"][id$="-0"]');

    // Bank 1 holds the sound that travels; bank 3 holds the one that is about
    // to be deleted. Naming them apart is what makes "which bank did it
    // replace" a question with an answer.
    await tabs.nth(0).click();
    const travelling = "import-ui-travelling";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(travelling));
    await expect(padZero).toContainText(travelling);

    await tabs.nth(2).click();
    const doomed = "import-ui-doomed";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(doomed));
    await expect(padZero).toContainText(doomed);

    // Pull bank 3 to position 1. From here on its position is 1 and its
    // identity is still the third bank's.
    await latchEditMode(page);
    await keyboardDragTab(page, 2, "ArrowLeft");
    await expect(tabs.nth(1)).toHaveText("2: Bank 3");
    await expect(tabs.nth(2)).toHaveText("3: Bank 2");
    await unlatchEditMode(page);

    await openProfileManager(page);
    await page.getByRole("button", { name: "Import / Export" }).click();

    // Send bank 1 out ...
    const options = page.locator('[data-testid="export-bank-option"]');
    await expect(options.nth(0).locator("label")).toHaveText("1: Bank 1");
    await options
      .nth(0)
      .locator('[data-testid="export-bank-checkbox"]')
      .click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-selected-banks").click();
    const archivePath = testInfo.outputPath("banks.iaz");
    await (await downloadPromise).saveAs(archivePath);

    // ... and bring it straight back in.
    await page
      .getByTestId("import-profile-file-input")
      .setInputFiles(archivePath);
    const dialog = page.getByTestId("bank-import-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("bank-import-name")).toHaveText(
      "1: Bank 1",
    );
    await expect(dialog.getByTestId("bank-import-summary")).toHaveText(
      "1 pad, 1 sound",
    );

    // The archive says which bank it came from, and that bank is still here,
    // so the dialog opens on a replace of it rather than on an add.
    const placement = page.getByTestId("bank-placement-0");
    await expect(placement).toHaveValue(/^replace:/);
    await expect(dialog.getByTestId("bank-import-consequence")).toContainText(
      "Deletes everything in 1: Bank 1 (1 pad, 1 sound)",
    );

    // Aim it at the bank that has moved instead, by the words on the option.
    await placement.selectOption({ label: "Replace 2: Bank 3" });
    await expect(dialog.getByTestId("bank-import-consequence")).toHaveText(
      "Deletes everything in 2: Bank 3 (1 pad, 1 sound), and cannot be undone.",
    );

    // By the button's *name*, not its test id. The Import / Export tab is
    // crowded — a profile export, a bank export and a file picker all live
    // above this — and Task 14 shipped a bank button whose accessible name
    // was already taken by the profile export directly above it, which turned
    // two existing specs into strict-mode violations. Playwright's strict
    // mode is the check: these two lines fail if anything else on the page
    // answers to the same name.
    const confirm = page.getByRole("button", { name: "Import 1 Bank" });
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(page.getByTestId("bank-import-result")).toContainText(
      /Imported 1 bank into /,
    );
    await page.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Close" }).first().click();

    // Nothing below reloads the page, so the tabs are the board being told.
    // Ten of them: a replace must not add a bank. And the tab at position 1
    // carries the *imported* bank's name, which is how a replace shows.
    await expect(tabs).toHaveCount(10);
    await expect(tabs.nth(1)).toHaveText("2: Bank 1");
    await expect(tabs.nth(0)).toHaveText("1: Bank 1");

    await tabs.nth(1).click();
    await expect(padZero).toContainText(travelling);
    // The bank was emptied before it was written, so the sound it used to
    // hold is gone from the board rather than sitting alongside.
    await expect(page.getByText(doomed)).toHaveCount(0);
    await activatePad(page, padZero);

    // And the bank the dialog did *not* name is untouched.
    await tabs.nth(2).click();
    await expect(tabs.nth(2)).toHaveText("3: Bank 2");
  });
});
