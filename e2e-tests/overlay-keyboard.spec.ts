import { test, expect, type Page } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  openProfileManager,
  getActiveSounds,
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
/**
 * Press Escape with the profile manager on top, and check what it did.
 *
 * The two assertions are in this order deliberately. Escape has to *do*
 * something — the guard once shipped without the dismissal, and between the two
 * changes Escape was a dead key that neither stopped the audio nor closed the
 * thing that had taken it, leaving the × in the corner as the only way out. The
 * overlay closing is also the observable consequence of this exact keypress, so
 * waiting for it first puts the "still playing" check *after* the press has
 * been handled. The other order asserted a state that was already true:
 * playback was running before Escape, so `toBeHidden` succeeded on its first
 * poll and a panic stop a few hundred milliseconds late — the speed this suite
 * runs at under load — went unnoticed.
 */
async function escapeDismissesOnlyTheOverlay(page: Page) {
  await page.keyboard.press("Escape");

  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeHidden();

  // Escape belongs to whatever is on top. Reaching the soundboard means it
  // silenced a sound the user could not see they were stopping — the worst
  // version of this for a live board.
  await expect(page.locator("text=Nothing playing")).toBeHidden();
}

test.describe("the profile manager owns the keyboard", () => {
  test("a pad key does not fire a sound behind the overlay", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    // Two pads, because "nothing is playing" was already true before the key
    // was pressed. `toBeVisible()` on "Nothing playing" then succeeded on its
    // first poll, and a leak that started playback a few hundred milliseconds
    // later — which is the speed this suite runs at under load — passed. The
    // second pad is a barrier: its sound cannot be audible until after the key
    // press being tested has been processed, so by the time it plays a leaked
    // first sound would be playing too.
    const guarded = "overlay-guard";
    const barrier = "overlay-barrier";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(guarded));
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(guarded);
    await page
      .locator('[data-testid="pad-drop-input-1"]')
      .setInputFiles(await createTestAudioFilePath(barrier));
    await expect(page.locator('[id^="pad-"][id$="-1"]')).toContainText(barrier);

    await openProfileManager(page);
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Focus the dialog itself rather than a text field: typing into an input
    // was always guarded, and that is not the case this is about.
    await page.getByRole("heading", { name: "Profile Manager" }).click();
    await page.keyboard.press("q");

    // Close the overlay and fire the *other* pad. Clicked rather than keyed,
    // so the barrier does not depend on the listener this test is accusing.
    await page.getByLabel("Close").click();
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeHidden();
    await page.locator('[id^="pad-"][id$="-1"]').click();

    await expect
      .poll(async () => (await getActiveSounds(page)).map((s) => s.name), {
        message: "the second pad should be playing",
      })
      .toContain(barrier);

    // Only the pad pressed with nothing on top is playing.
    const names = (await getActiveSounds(page)).map((sound) => sound.name);
    expect(names).not.toContain(guarded);
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

    await escapeDismissesOnlyTheOverlay(page);
  });

  test("Escape is the panic stop again once the overlay has closed", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "overlay-escape-twice";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await activatePad(page, pad, "q");

    await openProfileManager(page);
    await page.getByRole("heading", { name: "Profile Manager" }).click();

    // First Escape: the overlay's, and only the overlay's.
    await escapeDismissesOnlyTheOverlay(page);

    // Second Escape: nothing is on top any more, so it is the panic button
    // the app documents it as.
    await page.keyboard.press("Escape");
    await expect(page.locator("text=Nothing playing")).toBeVisible();
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
