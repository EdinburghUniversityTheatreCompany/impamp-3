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
 *
 * Tabbing to a result was the first half of the answer and is still covered
 * here. The second half is that the *input* activates the first result, so the
 * fastest path has no Tab in it at all — which matters because the input keeps
 * focus after typing and what sits between it and the first result is layout.
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

  test("Enter in the search box plays the first result, with no Tab", async ({
    page,
  }) => {
    const fileName = "search-input-play";
    await searchFor(page, fileName);

    // No `tabToFirstResult` here, deliberately. The input keeps focus after
    // typing, and this is the whole claim: the fastest path from the search
    // chord to a sound has nothing between the last character and the Enter.
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).toBeVisible();
  });

  test("Ctrl+Enter in the search box arms the first result, with no Tab", async ({
    page,
  }) => {
    const fileName = "search-input-arm";
    await searchFor(page, fileName);

    await page.keyboard.press("Control+Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    // Armed, not played — and nothing fired the emergency bank either, which
    // is what a global Enter handler acting on the same press would do.
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("Enter never fires the result the previous query left on screen", async ({
    page,
  }) => {
    // The hook waits 300 ms before it reads anything and leaves the old
    // results up meanwhile, with nothing on screen or in its state saying so.
    // "Type, then Enter without moving focus" is the flow the input handler
    // exists for, so this was the ordinary way to use it — and it fired the
    // cue for the query the operator had just replaced.
    const fileName = "search-stale-cue";
    await searchFor(page, fileName);

    // A term nothing matches, so the assertions below hold whichever side of
    // the debounce the Enter lands on: refused while the old results are still
    // up, or ignored once the new (empty) ones have arrived. What must not
    // happen either way is the sound from the first query playing.
    await page
      .locator('[data-testid="search-input"]')
      .fill("no-such-sound-at-all");
    await page.keyboard.press("Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="search-result-item"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).toBeHidden();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("the results header says how to do it", async ({ page }) => {
    await searchFor(page, "search-input-hint");

    await expect(
      page.locator('[data-testid="search-activation-hint"]'),
    ).toContainText("Enter");
  });

  test("a result announces itself as a button", async ({ page }) => {
    const fileName = "search-key-role";
    await searchFor(page, fileName);

    await expect(
      page.locator('[data-testid="search-result-item"]').first(),
    ).toHaveRole("button");
  });
});
