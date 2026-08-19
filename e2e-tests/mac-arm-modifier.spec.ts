import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
} from "./test-helpers";

/**
 * Command counts as the arm chord, everywhere Control does.
 *
 * macOS reserves Control+click as the secondary click, and the browser acts on
 * that before the page ever sees it: Chrome dispatches `contextmenu` and no
 * `click` at all, Firefox dispatches `auxclick`, and only Safari still
 * delivers a `click` (on top of a context menu the operator did not ask for).
 * So an arm chord bound to Control alone is simply unreachable with a mouse on
 * a Mac — the pad played instead of arming, or did nothing.
 *
 * Command is the modifier macOS leaves to the application, and it arrives as
 * an ordinary click. These tests drive Meta, which is what Playwright calls
 * it, and the existing Control tests in `armed-tracks.spec.ts`,
 * `pad-keyboard.spec.ts` and `search-result-keyboard.spec.ts` are what keep
 * the Windows and Linux chord alive alongside it.
 */

/**
 * Tab forward until the focused element is a search result, or give up.
 *
 * Deliberately not a fixed number of presses: what sits between the input and
 * the first result is layout, and a test that encodes it would fail for a
 * reason that is not this one.
 */
async function tabToFirstResult(page: import("@playwright/test").Page) {
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

async function loadPadZero(
  page: import("@playwright/test").Page,
  name: string,
) {
  await gotoApp(page);
  await prepareAudioContext(page);

  await page
    .locator('[data-testid="pad-drop-input-0"]')
    .setInputFiles(await createTestAudioFilePath(name));

  const pad = page.locator('[id^="pad-"][id$="-0"]');
  // The chord only arms a pad that already holds sound; arming in the same
  // breath as the load is a race.
  await expect(pad).toContainText(name);
  return pad;
}

test.describe("the macOS arm chord", () => {
  test("Cmd+Click arms a pad instead of playing it", async ({ page }) => {
    const pad = await loadPadZero(page, "mac-arm-click");

    await page.keyboard.down("Meta");
    await pad.click();
    await page.keyboard.up("Meta");

    // The star, and the panel that only exists while something is armed.
    await expect(pad.locator(".text-amber-500")).toBeVisible();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    // Armed, not played — the whole distinction the chord exists for.
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("Cmd+Enter arms the focused pad", async ({ page }) => {
    const pad = await loadPadZero(page, "mac-arm-enter");

    await pad.focus();
    await page.keyboard.press("Meta+Enter");

    await expect(pad.locator(".text-amber-500")).toBeVisible();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("Cmd+F opens the search modal", async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    await page.keyboard.press("Meta+f");

    await expect(page.locator('[data-testid="search-modal"]')).toBeVisible();
  });

  test("Cmd+Click arms a search result", async ({ page }) => {
    const fileName = "mac-arm-search-click";
    await loadPadZero(page, fileName);

    await page.locator('[data-testid="search-button"]').click();
    await expect(page.locator('[data-testid="search-modal"]')).toBeVisible();
    await page.locator('[data-testid="search-input"]').fill(fileName);
    const result = page.locator('[data-testid="search-result-item"]').first();
    await expect(result).toBeVisible();

    await page.keyboard.down("Meta");
    await result.click();
    await page.keyboard.up("Meta");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("Cmd+Enter arms a search result", async ({ page }) => {
    const fileName = "mac-arm-search-enter";
    await loadPadZero(page, fileName);

    await page.locator('[data-testid="search-button"]').click();
    await expect(page.locator('[data-testid="search-modal"]')).toBeVisible();
    await page.locator('[data-testid="search-input"]').fill(fileName);
    await expect(
      page.locator('[data-testid="search-result-item"]').first(),
    ).toBeVisible();

    // The chord is read by the result's own key handler, so focus has to be on
    // the result — the search input still holds it after typing.
    await tabToFirstResult(page);
    await page.keyboard.press("Meta+Enter");

    await expect(page.locator('[data-testid="search-modal"]')).toBeHidden();
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });
});
