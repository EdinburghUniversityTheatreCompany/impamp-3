/**
 * Failures are reported without stopping the show.
 *
 * Two things this spec proves that no unit test can. First, that a failed
 * press reaches the operator in the shipped bundle: `Pad.tsx` rendered an
 * `"error"` overlay for a year that nothing ever set, and a jsdom test of the
 * component would have passed the whole time. Second, the property the notice
 * system exists for — that while a failure is on screen, ESC still stops
 * audio. The seventeen `window.alert` calls this replaced blocked the page's
 * JavaScript until dismissed, so a native dialog appearing here is itself a
 * failure, whatever it says.
 *
 * The one reproducible way to make a pad fail is the state a board is in
 * after a sync brought the pads across and the audio did not: the row is
 * gone, the pad still names it. The decoded buffer is cached in memory, so
 * the deletion is followed by a reload before the press.
 */
import { test, expect, type Dialog } from "@playwright/test";
import {
  activatePad,
  clearAudioFiles,
  createTestAudioFilePath,
  expectNothingPlaying,
  gotoApp,
  prepareAudioContext,
  waitForAppReady,
} from "./test-helpers";

test.describe("Error notices", () => {
  test("a pad that cannot play says so, and ESC still works while it does", async ({
    page,
  }) => {
    const dialogs: Dialog[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog);
      void dialog.dismiss();
    });

    await gotoApp(page);
    await prepareAudioContext(page);

    const brokenPad = page.locator('[id^="pad-"]').nth(0);
    const workingPad = page.locator('[id^="pad-"]').nth(1);

    // A sound whose row is about to disappear from under its pad.
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath("Broken_Cue"));
    await expect(brokenPad).toContainText("Broken_Cue");

    await clearAudioFiles(page);
    await page.reload();
    await waitForAppReady(page);
    await prepareAudioContext(page);
    await expect(brokenPad).toContainText("Broken_Cue");

    // A second sound, added after the purge, so something on the board can
    // actually play while the failure is showing.
    await page
      .locator('[data-testid="pad-drop-input-1"]')
      .setInputFiles(await createTestAudioFilePath("Working_Cue"));
    await expect(workingPad).toContainText("Working_Cue");

    // The failed press: the pad says which, the notice says why. The engine
    // retries for a few seconds before it gives up, which is inside the
    // configured expect timeout.
    await brokenPad.click();
    await expect(brokenPad.getByTestId("pad-load-error")).toBeVisible();
    const notice = page
      .getByTestId("notice")
      .filter({ hasText: "Could not play Broken_Cue" });
    await expect(notice).toBeVisible();

    // The property this whole change is for: the board is still live.
    await activatePad(page, workingPad);
    await page.keyboard.press("Escape");
    await expectNothingPlaying(page);
    await expect(notice).toBeVisible();

    // The overlay clears itself; the notice waits to be dismissed.
    await expect(brokenPad.getByTestId("pad-load-error")).toBeHidden();
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toBeHidden();

    expect(dialogs).toEqual([]);
  });
});
