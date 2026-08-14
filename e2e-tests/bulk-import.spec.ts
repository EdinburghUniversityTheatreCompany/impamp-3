import { test, expect } from "@playwright/test";
import {
  gotoApp,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  createTestAudioFilePath,
} from "./test-helpers";

/**
 * The bulk import modal seeds its per-pad assignment list from the grid's
 * current configuration. That seeding used to run in an effect keyed on the
 * config map, which would also have thrown away in-progress assignments if the
 * map changed identity while the modal was open.
 */
test.describe("Bulk import", () => {
  test("lists every pad, showing which are already configured", async ({
    page,
  }) => {
    await gotoApp(page);

    // Give one pad a sound so the modal has a configured pad to reflect.
    const filePath = await createTestAudioFilePath("bulk-existing");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [filePath]);
    await savePadEditModal(page);
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      "bulk-existing",
    );

    // Bulk Import lives behind the delete/move toggle in the toolbar.
    await page
      .getByRole("button", { name: "Toggle delete and move mode" })
      .click();
    await page.getByRole("button", { name: /Bulk Import/ }).click();

    await expect(page.getByText("Bulk Import Audio Files")).toBeVisible();
    // The pad that already has a sound is named after it in the assignment list
    await expect(
      page.locator('[data-testid="custom-modal"]').getByText("bulk-existing"),
    ).toBeVisible();
  });
});
