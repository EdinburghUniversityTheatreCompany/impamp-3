import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  activatePad,
} from "./test-helpers";

/**
 * A sound assigned by bulk import must answer to its key.
 *
 * Pad configurations were held in three places: IndexedDB, the grid's copy in
 * `usePadConfigurations`, and a second copy in `useKeyboardListener`'s own
 * `padConfigsRef`. The grid's copy was invalidated by `padConfigsVersion` *or*
 * a hook-local `reloadToken`; the keyboard's only by `padConfigsVersion`. So a
 * write path that called `refreshPadConfigs()` without also calling
 * `incrementPadConfigsVersion()` updated what you could see and not what you
 * could play, until you switched bank or profile.
 *
 * Bulk import is one of the two paths that did exactly that, and it is the
 * starker of the two: *every* pad it fills is mute to the keyboard.
 */
test.describe("Bulk import and the keyboard", () => {
  test("a bulk-imported sound plays from its key without switching bank", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "bulk-keyboard";
    const filePath = await createTestAudioFilePath(fileName);

    // Bulk Import lives behind the delete/move toggle in the toolbar.
    await page
      .getByRole("button", { name: "Toggle delete and move mode" })
      .click();
    await page.getByRole("button", { name: /Bulk Import/ }).click();
    await expect(page.getByText("Bulk Import Audio Files")).toBeVisible();

    await page.locator("#bulk-import-file-input").setInputFiles(filePath);
    // Auto-Assign fills the unconfigured pads in order, so with an empty grid
    // the one file lands on pad 0 — the pad bound to "q".
    await page.getByRole("button", { name: "Auto-Assign" }).click();
    await page.getByRole("button", { name: "Save Assignments" }).click();

    // The grid updates either way; that was never the broken half.
    const firstPad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(firstPad).toContainText(fileName);

    // Leave delete/move mode so a keypress is an ordinary trigger.
    await page
      .getByRole("button", { name: "Toggle delete and move mode" })
      .click();

    // The assertion that mattered: no bank switch, no profile switch, no
    // reload — just the key. Before the fix this timed out, because the
    // keyboard listener's map was still the pre-import one.
    await activatePad(page, firstPad, "q");

    await expect(
      page
        .locator('[data-testid="active-tracks-panel"]')
        .getByText(fileName, { exact: false }),
    ).toBeVisible();
  });
});
