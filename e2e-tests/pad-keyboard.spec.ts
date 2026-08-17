import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
} from "./test-helpers";

/**
 * A focused pad honours Enter and Space; an unfocused board does not change.
 *
 * `Pad` renders `role="button" tabIndex={0}` and handled only `onClick`. ARIA
 * requires a `role="button"` element to activate on Enter and Space, and this
 * one activated on neither — so a screen reader announced "Sound pad 3:
 * Applause, button" and pressing Enter played the emergency bank instead.
 *
 * The fix deliberately does *not* touch the app's keyboard model. Enter is the
 * emergency sound and Space is Fade Out All, globally, and they have to keep
 * meaning that at every moment of a show — an operator reaching for the
 * emergency sound cannot have it depend on which pad they last clicked. So a
 * pointer click no longer parks focus on the pad, and pad-level Enter/Space
 * apply only to focus a keyboard user placed there on purpose. The last test
 * here is the one that guards that, and it is the reason the blur exists.
 */
test.describe("a focused pad is operable from the keyboard", () => {
  test("Enter plays the focused pad rather than the emergency bank", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "pad-enter";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await pad.focus();
    await page.keyboard.press("Enter");

    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).toBeVisible();
  });

  test("Space plays the focused pad rather than fading everything out", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "pad-space";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await pad.focus();
    await page.keyboard.press(" ");

    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).toBeVisible();
  });

  test("Ctrl+Enter arms the focused pad, as Ctrl+Click does", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "pad-ctrl-enter";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await pad.focus();
    await page.keyboard.press("Control+Enter");

    // The star, and the panel that only exists while something is armed.
    await expect(pad.locator(".text-amber-500")).toBeVisible();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("clicking a pad leaves Space meaning Fade Out All", async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "pad-click-then-space";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await pad.click();
    await expect(page.locator("text=Nothing playing")).toBeHidden();

    // The mouse must not steal the transport keys. Without the blur this would
    // retrigger the pad the operator last touched instead of fading the room.
    await page.keyboard.press(" ");
    await expect(
      page
        .locator('[data-testid="active-tracks-panel"]')
        .getByText("fading out..."),
    ).toBeVisible();
  });
});
