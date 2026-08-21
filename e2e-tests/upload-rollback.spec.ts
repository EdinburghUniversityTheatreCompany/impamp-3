import { test, expect } from "@playwright/test";
import {
  gotoApp,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  createTestAudioFilePath,
  countAudioFiles,
} from "./test-helpers";

/**
 * Adding a sound in the pad editor writes the blob to IndexedDB straight away,
 * so abandoning the modal used to leave it there forever — the Profile Manager
 * grew a manual "delete orphaned audio files" button to mop up after it.
 */
test.describe("pad editor upload rollback", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("discards the blob when the modal is cancelled", async ({ page }) => {
    const before = await countAudioFiles(page);

    const filePath = await createTestAudioFilePath("cancelled-upload");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [filePath]);
    await page.locator('[data-testid="modal-cancel-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    expect(await countAudioFiles(page)).toBe(before);
    // And the pad kept nothing
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      "Empty Pad",
    );
  });

  test("discards the blob when the modal is dismissed with Escape", async ({
    page,
  }) => {
    const before = await countAudioFiles(page);

    const filePath = await createTestAudioFilePath("escaped-upload");
    await openEditPadModal(page, 1);
    await addSoundsToPadModal(page, [filePath]);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    expect(await countAudioFiles(page)).toBe(before);
  });

  test("keeps the blob when the modal is saved", async ({ page }) => {
    const before = await countAudioFiles(page);

    const filePath = await createTestAudioFilePath("saved-upload");
    await openEditPadModal(page, 2);
    await addSoundsToPadModal(page, [filePath]);
    await savePadEditModal(page);
    await expect(page.locator('[id^="pad-"][id$="-2"]')).toContainText(
      "saved-upload",
    );

    expect(await countAudioFiles(page)).toBe(before + 1);
  });
});
