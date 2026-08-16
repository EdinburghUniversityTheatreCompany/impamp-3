import { test, expect, Page } from "@playwright/test";
import {
  prepareAudioContext,
  createMultipleTestAudioFiles,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  setPadActiveInModal,
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

/**
 * A positive signal that the app has finished processing input, for tests whose
 * real assertion is that *nothing* happened.
 *
 * These used to be a flat `waitForTimeout(500)`. A fixed sleep is the whole
 * window in which a regression can be caught, so under parallel load a pad
 * that wrongly started playing at 550ms passed. Triggering a pad that *should*
 * play and waiting for it gives an actual event to wait on: by the time the
 * control pad is audible, the disabled one would have started too.
 */
async function playControlPad(page: Page, padIndex: number, name: string) {
  const control = await setUpPad(page, padIndex, name);
  await control.click({ force: true });
  await expect(control.locator(".bg-green-500")).toBeVisible();
  return control;
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

    // The disabled pad must still be silent once a later trigger is audible.
    const control = await playControlPad(page, 1, "controlClick");

    await expect(pad.locator(".bg-green-500")).toBeHidden();
    await expect(control.locator(".bg-green-500")).toBeVisible();
  });

  test("a disabled pad does not play when its key is pressed", async ({
    page,
  }) => {
    // Pad 0 is bound to "q" by default.
    const pad = await setUpPad(page, 0, "disabledKey", { disabled: true });

    await page.keyboard.press("q");

    const control = await playControlPad(page, 1, "controlKey");

    await expect(pad.locator(".bg-green-500")).toBeHidden();
    await expect(control.locator(".bg-green-500")).toBeVisible();
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
    const control = await setUpPad(page, 4, "armControl");

    await page.keyboard.down("Control");
    await pad.click({ force: true });
    await page.keyboard.up("Control");

    // Arm a pad that *can* be armed, and wait for that. The panel appearing is
    // the positive event proving arming has been processed — a fixed sleep was
    // just a guess at how long that takes.
    await page.keyboard.down("Control");
    await control.click({ force: true });
    await page.keyboard.up("Control");
    await expect(control.locator(".text-amber-500")).toBeVisible();

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
