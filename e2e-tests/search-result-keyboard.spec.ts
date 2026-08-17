import { test, expect, type Page } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
} from "./test-helpers";

/**
 * Search results can be reached and fired from the keyboard.
 *
 * They were bare divs: `onClick` and `cursor-pointer`, no role, no tabIndex, no
 * key handler. The `aria-disabled` they carried was inert, because a div with
 * no role has no state for it to qualify. And `handleResultClick` branched on
 * `e.ctrlKey`, so arming a cue from search existed only as a mouse chord.
 *
 * That made this the one flow in the app that starts at the keyboard and
 * dead-ends there: Ctrl+F opens the modal and focuses its input, you type, and
 * then the results need a mouse.
 */

/**
 * Tab forward until the focused element is a search result, or give up.
 *
 * Deliberately not a fixed number of presses: what sits between the input and
 * the first result is layout, and a test that encodes it would fail for a
 * reason that is not this one. The bound is what makes it a test rather than a
 * hang.
 */
async function tabToFirstResult(page: Page) {
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    const onResult = await page.evaluate(
      () =>
        document.activeElement?.getAttribute("data-testid") ===
        "search-result-item",
    );
    if (onResult) return;
  }
  throw new Error("Tab never reached a search result");
}

async function searchFor(page: Page, fileName: string) {
  await gotoApp(page);
  await prepareAudioContext(page);

  await page
    .locator('[data-testid="pad-drop-input-0"]')
    .setInputFiles(await createTestAudioFilePath(fileName));
  await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(fileName);

  await page.locator('[data-testid="search-button"]').click();
  await expect(page.locator('[data-testid="search-modal"]')).toBeVisible();
  await page.locator('[data-testid="search-input"]').fill(fileName);
  await expect(
    page.locator('[data-testid="search-result-item"]').first(),
  ).toBeVisible();
}

test.describe("search results from the keyboard", () => {
  test("Tab reaches a result and Enter plays it", async ({ page }) => {
    const fileName = "search-key-play";
    await searchFor(page, fileName);

    await tabToFirstResult(page);
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).toBeVisible();
  });

  test("Ctrl+Enter arms the result, as Ctrl+Click does", async ({ page }) => {
    const fileName = "search-key-arm";
    await searchFor(page, fileName);

    await tabToFirstResult(page);
    await page.keyboard.press("Control+Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    // Armed, not played — the whole distinction the chord exists for.
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("a result announces itself as a button", async ({ page }) => {
    const fileName = "search-key-role";
    await searchFor(page, fileName);

    await expect(
      page.locator('[data-testid="search-result-item"]').first(),
    ).toHaveRole("button");
  });
});
