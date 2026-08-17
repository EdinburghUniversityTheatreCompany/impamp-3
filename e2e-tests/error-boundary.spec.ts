import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  activatePad,
} from "./test-helpers";

/**
 * A render error must not take the soundboard down with it.
 *
 * The four biggest modals are `React.lazy`, and `ModalRenderer` put them behind
 * a bare `Suspense`. `Suspense` handles the *pending* case only: a rejected
 * `import()` re-throws on the next render, and with no boundary anywhere in the
 * tree React unmounts everything and Next renders "Application error: a
 * client-side exception has occurred" in its place.
 *
 * That is the worst failure this app has. The Web Audio graph lives at module
 * scope, so whatever was playing keeps playing — while the only thing that
 * could stop it, the Escape panic key, has just been unmounted along with the
 * grid. Recovery was a page reload, mid-show.
 *
 * A chunk that fails to load is not hypothetical: it is what an offline PWA,
 * a redeploy that rotated the build id, or a flaky venue network produces.
 * These tests reproduce it the same way, by refusing the chunk request.
 */

/** Refuse every asset the page has not already fetched. */
async function breakLazyChunks(page: import("@playwright/test").Page) {
  await page.route("**/_next/static/**", (route) => route.abort("failed"));
}

test.describe("a failed lazy chunk does not unmount the soundboard", () => {
  test("the grid survives, and the fallback can stop the audio", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "boundary-sound";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    // Something is playing, exactly as it would be mid-show.
    await activatePad(page, pad, "q");
    await expect(page.locator("text=Nothing playing")).toBeHidden();

    await breakLazyChunks(page);
    await page.getByTestId("help-button").click();

    // The dialog is the only thing that failed, so only the dialog is replaced.
    const fallback = page.getByTestId("modal-error-fallback");
    await expect(fallback).toBeVisible();

    // The soundboard is still mounted and still playing.
    await expect(pad).toContainText(fileName);
    await expect(page.locator("text=Nothing playing")).toBeHidden();

    // And the fallback offers the panic stop, because the keyboard route to it
    // is not something we can promise once a render has thrown.
    await fallback.getByRole("button", { name: "Stop all sounds" }).click();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("dismissing the fallback leaves the app usable", async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    await breakLazyChunks(page);
    await page.getByTestId("help-button").click();
    await expect(page.getByTestId("modal-error-fallback")).toBeVisible();

    await page
      .getByTestId("modal-error-fallback")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.getByTestId("modal-error-fallback")).toBeHidden();

    // Bank switching still works, which is the cheapest proof the keyboard
    // listener and the grid both outlived the failure.
    await page.keyboard.press("2");
    await expect(
      page.locator('[role="tab"][aria-selected="true"]'),
    ).toContainText("2");
  });
});
