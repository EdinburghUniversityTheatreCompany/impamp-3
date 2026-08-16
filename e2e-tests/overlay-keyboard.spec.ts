import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  openProfileManager,
  expectNothingPlaying,
  activatePad,
} from "./test-helpers";

/**
 * An overlay owns the keyboard while it is up.
 *
 * "Something is open on top" was tracked in three unconnected places — the
 * modal store, a React context for search, and the profile store for the
 * profile manager — and the keyboard listener guarded on two of them. The
 * profile manager is rendered outside the modal system, so with it open and
 * focus anywhere that is not a text field, every soundboard key was still
 * live behind the overlay.
 */
test.describe("the profile manager owns the keyboard", () => {
  test("a pad key does not fire a sound behind the overlay", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "overlay-guard";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      fileName,
    );

    await openProfileManager(page);
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Focus the dialog itself rather than a text field: typing into an input
    // was always guarded, and that is not the case this is about.
    await page.getByRole("heading", { name: "Profile Manager" }).click();
    await page.keyboard.press("q");

    await expectNothingPlaying(page);
  });

  test("Escape does not run the panic stop behind the overlay", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "overlay-escape";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    // Start it playing, so Escape has something to stop.
    await activatePad(page, pad, "q");
    await expect(page.locator("text=Nothing playing")).toBeHidden();

    await openProfileManager(page);
    await page.getByRole("heading", { name: "Profile Manager" }).click();
    await page.keyboard.press("Escape");

    // Escape belongs to whatever is on top. Reaching the soundboard means it
    // silenced a sound the user could not see they were stopping — the worst
    // version of this for a live board.
    await expect(page.locator("text=Nothing playing")).toBeHidden();
  });

  test("a bank key does not switch bank behind the overlay", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    await openProfileManager(page);
    await page.getByRole("heading", { name: "Profile Manager" }).click();
    await page.keyboard.press("2");

    await page.getByLabel("Close").click();
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeHidden();

    // Bank 1 is still the selected tab.
    await expect(
      page.locator('[role="tab"][aria-selected="true"]'),
    ).toContainText("1");
  });
});
