import { test, expect, Page } from "@playwright/test";
import {
  prepareAudioContext,
  createMultipleTestAudioFiles,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  setPadActiveInModal,
  expectNothingPlaying,
  activatePad,
  gotoApp,
} from "./test-helpers";

/**
 * Assigns a sound to a pad via the edit modal, optionally disabling the pad in
 * the same pass, and returns a locator for the pad.
 */
async function setUpPad(
  page: Page,
  padIndex: number,
  soundName: string,
  { disabled = false }: { disabled?: boolean } = {},
) {
  const filePaths = await createMultipleTestAudioFiles([soundName]);

  await openEditPadModal(page, padIndex);
  await addSoundsToPadModal(page, filePaths);
  if (disabled) {
    await setPadActiveInModal(page, false);
  }
  await savePadEditModal(page);

  return page.locator(`[id^="pad-"][id$="-${padIndex}"]`);
}

test.describe("Pad disable", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  test("pads are active by default", async ({ page }) => {
    await openEditPadModal(page, 0);
    await expect(
      page.locator('[data-testid="edit-pad-active-checkbox"]'),
    ).toBeChecked();
  });

  test("a disabled pad does not play when clicked", async ({ page }) => {
    const pad = await setUpPad(page, 0, "disabledClick", { disabled: true });

    await pad.click({ force: true });
    await page.waitForTimeout(500);

    await expectNothingPlaying(page);
    await expect(pad.locator(".bg-green-500")).toBeHidden();
  });

  test("a disabled pad does not play when its key is pressed", async ({
    page,
  }) => {
    // Pad 0 is bound to "q" by default.
    await setUpPad(page, 0, "disabledKey", { disabled: true });

    await page.keyboard.press("q");
    await page.waitForTimeout(500);

    await expectNothingPlaying(page);
  });

  test("the disabled state persists, and re-enabling restores playback", async ({
    page,
  }) => {
    const pad = await setUpPad(page, 1, "toggleMe", { disabled: true });

    // Re-open the modal: the checkbox should still be unticked.
    await openEditPadModal(page, 1);
    await expect(
      page.locator('[data-testid="edit-pad-active-checkbox"]'),
    ).not.toBeChecked();

    // Tick it again and save.
    await setPadActiveInModal(page, true);
    await savePadEditModal(page);

    // The pad plays again.
    await activatePad(page, pad);
  });

  test("a disabled pad is visually marked and can still be edited", async ({
    page,
  }) => {
    const pad = await setUpPad(page, 2, "markedPad", { disabled: true });

    await expect(pad).toHaveAttribute("aria-disabled", "true");
    await expect(
      pad.locator('[data-testid="pad-disabled-indicator"]'),
    ).toBeVisible();

    // Edit mode still opens the modal, so the pad can be re-enabled.
    await openEditPadModal(page, 2);
    await expect(
      page.locator('[data-testid="edit-pad-active-checkbox"]'),
    ).not.toBeChecked();
  });

  test("a disabled pad cannot be armed with Ctrl+Click", async ({ page }) => {
    const pad = await setUpPad(page, 3, "armMe", { disabled: true });

    await page.keyboard.down("Control");
    await pad.click({ force: true });
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);

    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeHidden();
    await expect(pad.locator(".text-amber-500")).toBeHidden();
  });

  test("disabling a pad disarms it", async ({ page }) => {
    const pad = await setUpPad(page, 4, "disarmMe");

    // Arm it while it is still active.
    await page.keyboard.down("Control");
    await pad.click({ force: true });
    await page.keyboard.up("Control");
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();

    // Disabling should drop the armed cue.
    await openEditPadModal(page, 4);
    await setPadActiveInModal(page, false);
    await savePadEditModal(page);

    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeHidden();
  });
});
