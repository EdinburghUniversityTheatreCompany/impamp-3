import { test, expect } from "@playwright/test";
import {
  gotoApp,
  createTestAudioFilePath,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
} from "./test-helpers";

/**
 * The first-use tour (issue #8), in a browser, because every claim it makes is
 * about a real first load: does it appear at all, does it stay gone once
 * dismissed, and — the one that matters — does it stay away from a board that
 * has sounds on it.
 *
 * That last case cannot be a unit test. `shouldOfferWelcomeTour` is pure and
 * already covered; what this asserts is that the count it is handed is the
 * real one, read from IndexedDB by the initializer on a real page load. Wiring
 * that to the wrong number is precisely how a tutorial ends up over someone's
 * cues mid-show.
 */
test.describe("first-use tour", () => {
  test("greets a brand-new board, and does not come back", async ({ page }) => {
    await gotoApp(page, { showWelcomeTour: true });

    const tour = page.getByTestId("welcome-tour");
    await expect(tour).toBeVisible();
    await expect(page.getByTestId("welcome-tour-title")).toHaveText(
      "Every pad is a key",
    );

    // Forward through every step, then out.
    await page.getByTestId("welcome-tour-next").click();
    await page.getByTestId("welcome-tour-next").click();
    await page.getByTestId("welcome-tour-back").click();
    await expect(page.getByTestId("welcome-tour-title")).toHaveText(
      "Put a sound on a pad",
    );
    await page.getByTestId("welcome-tour-next").click();
    await page.getByTestId("welcome-tour-next").click();
    await page.getByTestId("welcome-tour-next").click();
    await expect(tour).toBeHidden();

    await page.reload();
    await page.waitForSelector('[id^="pad-"]');
    await expect(tour).toBeHidden();
  });

  test("stays dismissed when it is closed with Escape, not the button", async ({
    page,
  }) => {
    // The path the button never takes. `Modal` reaches `onCancel` only from
    // its Cancel button, so a tour that recorded its answer there recorded
    // nothing for Escape, the × or a backdrop click — and came back on every
    // load. Skip was already covered; this is the dismissal a first-time user
    // is at least as likely to reach for.
    await gotoApp(page, { showWelcomeTour: true });
    await expect(page.getByTestId("welcome-tour")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("welcome-tour")).toBeHidden();

    // The recorded answer, not the absence of a modal. `toBeHidden` passes the
    // instant an element is missing, so after a reload it succeeds while the
    // tour's own IndexedDB read is still in flight — it cannot tell "dismissal
    // was remembered" from "the decision has not run yet", and passed with the
    // fix removed. This is the claim.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem("impamp:welcomeTourSeen"),
        ),
      )
      .toBe("1");

    await page.reload();
    await page.waitForSelector('[id^="pad-"]');
    await expect(page.getByTestId("welcome-tour")).toBeHidden();
  });

  test("stays away from a board that already has sounds", async ({ page }) => {
    await gotoApp(page, { showWelcomeTour: true });

    // Dismiss the tour this first load legitimately offers, then put a sound
    // on the board and clear the flag — so the only thing keeping it away on
    // the next load is the board no longer being empty.
    await page.getByTestId("welcome-tour-skip").click();
    await expect(page.getByTestId("welcome-tour")).toBeHidden();

    const file = await createTestAudioFilePath("tour-guard.wav");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [file]);
    await savePadEditModal(page);

    await page.evaluate(() =>
      window.localStorage.removeItem("impamp:welcomeTourSeen"),
    );
    await page.reload();
    await page.waitForSelector('[id^="pad-"]');

    await expect(page.getByTestId("welcome-tour")).toBeHidden();
  });
});
