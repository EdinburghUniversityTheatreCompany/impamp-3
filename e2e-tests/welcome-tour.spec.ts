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
      "Control ImpAmp with the keyboard",
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

    const file = await createTestAudioFilePath("tour-guard");
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

test.describe("where the tour is offered", () => {
  test("stays off a share link, which is where new users actually arrive", async ({
    page,
  }) => {
    // A brand-new device: nothing marks the tour seen, and no profile has any
    // configured pads — both halves of the gate are satisfied. They were also
    // satisfied on every other route, because the offer lived in
    // `ClientSideInitializer` and the root layout mounts that everywhere. The
    // first thing a new user does with a shared board is open its link, so
    // this page is the most likely place in the app to meet both conditions.
    //
    // `Modal`'s overlay is `fixed inset-0 z-50`, so the tour did not appear
    // beside this page's controls — it appeared over them.
    await page.goto("/server/open");

    // Wait for the app to have an active profile, which is the condition the
    // offer is waiting on too. Its mount hook is written synchronously with
    // hydration, so by the time this resolves the offer has either mounted or
    // does not exist on this route — and absence means something.
    //
    // Asserting on the modal alone does not: `toHaveCount(0)` is equally true
    // of a tour that simply has not finished its pad-count read, so that
    // version of this test passed with the offer mounted on every route.
    await page.waitForFunction(
      () =>
        (
          window as unknown as {
            __profileStore?: { getState(): { activeProfileId: number | null } };
          }
        ).__profileStore?.getState().activeProfileId != null,
    );

    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __impampWelcomeTourMounted?: boolean })
            .__impampWelcomeTourMounted ?? false,
      ),
    ).toBe(false);
    await expect(page.getByTestId("welcome-tour")).toHaveCount(0);
    await expect(page.locator(".custom-modal-overlay")).toHaveCount(0);
  });

  test("still greets the board itself", async ({ page }) => {
    // The other direction, so the test above cannot pass by the tour being
    // broken everywhere.
    await page.goto("/");
    await expect(page.getByTestId("welcome-tour")).toBeVisible();
  });
});
