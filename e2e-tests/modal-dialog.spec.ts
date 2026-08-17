import { test, expect, type Page } from "@playwright/test";
import { gotoApp } from "./test-helpers";

/**
 * The shared `Modal` behaves like a dialog.
 *
 * It was a bare pair of divs: no `role="dialog"`, no `aria-modal`, no
 * `aria-labelledby` pointing at the `<h2>` it renders thirty lines below, and
 * no effect that moved focus in, kept it there, or gave it back on close.
 * Opening the pad editor, the bank editor, Help, the bulk importer or the
 * conflict resolver therefore left focus on the trigger *behind* the overlay: a
 * screen reader announced nothing and carried on reading the obscured page, and
 * a keyboard user tabbed straight out of the dialog into it.
 *
 * Every modal in the app renders through `ModalRenderer`, so this is one place
 * that fixes all of them — which is also why it is worth pinning down here.
 */

/** Is the focused element inside the dialog? */
function focusIsInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="custom-modal"]');
    return (
      !!dialog &&
      !!document.activeElement &&
      dialog.contains(document.activeElement)
    );
  });
}

test.describe("the shared modal is a dialog", () => {
  test("announces itself, and is named by its own title", async ({ page }) => {
    await gotoApp(page);
    await page.getByTestId("help-button").click();

    const dialog = page.getByRole("dialog", { name: "ImpAmp3 Help" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  test("takes focus on open and returns it on close", async ({ page }) => {
    await gotoApp(page);

    const helpButton = page.getByTestId("help-button");
    await helpButton.focus();
    await helpButton.click();

    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await focusIsInsideDialog(page)).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Back where it came from, not lost to <body>.
    await expect(helpButton).toBeFocused();
  });

  test("keeps Tab inside the dialog, in both directions", async ({ page }) => {
    await gotoApp(page);
    await page.getByTestId("help-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Far more presses than the dialog has controls, so an untrapped Tab is
    // certain to have escaped by the end.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await focusIsInsideDialog(page)).toBe(true);
    }

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusIsInsideDialog(page)).toBe(true);
    }
  });
});
