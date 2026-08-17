import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  enterEditMode,
  exitEditMode,
} from "./test-helpers";

/**
 * The loudness overview calls a bank what everything else calls it.
 *
 * `getBankName` was hard-coded to `Bank ${pageIndex + 1}` and the component
 * never read `pageMetadata`, even though it was already doing an async load of
 * the profile's pads on mount. On a board with named banks the table's first
 * column and its bank filter said "Bank 1" while the tab directly above said
 * "1: Act 1 SFX", leaving the user to translate between two views of the same
 * board to find the sound they were looking at.
 */
test.describe("the loudness overview names banks", () => {
  test("uses the bank's real name in the table and the filter", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "loudness-bank-name";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      fileName,
    );

    // Name the bank the sound sits in, through the UI that owns bank names.
    const bankTab = page.locator('[role="tab"]').first();
    await enterEditMode(page);
    await bankTab.click();
    await page.locator('[data-testid="bank-name-input"]').fill("Act 1 SFX");
    await page.locator('[data-testid="modal-confirm-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
    await exitEditMode(page);
    await expect(bankTab).toContainText("Act 1 SFX");

    await page.getByTestId("loudness-overview-button").click();
    const overview = page.getByTestId("loudness-overview");
    await expect(overview).toBeVisible();

    // The "Bank · Pad" cell, which said "Bank 1 · 1".
    await expect(overview.locator("tbody tr").first()).toContainText(
      "Act 1 SFX · 1",
    );

    // And the filter that lists the banks holding sounds.
    await expect(
      page.getByTestId("loudness-bank-filter").locator("option"),
    ).toContainText(["All banks", "Act 1 SFX"]);
  });

  test("falls back to the bank number when a bank has no name", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "loudness-bank-unnamed";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      fileName,
    );

    await page.getByTestId("loudness-overview-button").click();
    await expect(page.getByTestId("loudness-overview")).toBeVisible();

    // A default profile's first bank is called "Bank 1" by the metadata
    // anyway, so the point of this test is that removing the hard-coded
    // string did not leave an empty cell where a name should be.
    await expect(
      page.getByTestId("loudness-overview").locator("tbody tr").first(),
    ).toContainText("Bank 1 · 1");
  });
});
