import { test, expect, type Page } from "@playwright/test";
import {
  createTestAudioFilePath,
  prepareAudioContext,
  gotoApp,
} from "./test-helpers";

/**
 * The chrome around the board has to be reachable from the keyboard, without
 * the board's transport keys becoming conditional on where focus happens to
 * be.
 *
 * `useKeyboardListener` used to swallow every Tab outside inputs and
 * overlays, so Search, Help, the mode toggles, the bank tabs and the profile
 * selector could not be reached without a mouse at all. The suppression was
 * there for a real reason — Enter is the emergency bank and Space is Fade Out
 * All, and neither may depend on which control was last touched — so this
 * suite pins both halves: Tab now walks the chrome, and the transport keys
 * still win whenever focus arrived by pointer rather than by Tab.
 */

/** What the focused element is, in the terms the assertions below use. */
async function focusedDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    const testId = el.getAttribute("data-testid");
    if (testId) return `testid:${testId}`;
    const id = el.id;
    if (id) return `id:${id}`;
    return `tag:${el.tagName.toLowerCase()}`;
  });
}

/** Tabs forward `count` times, reporting what held focus after each press. */
async function tabThrough(page: Page, count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press("Tab");
    seen.push(await focusedDescriptor(page));
  }
  return seen;
}

test.describe("the chrome is reachable from the keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("Tab walks the header controls and never parks on a pad", async ({
    page,
  }) => {
    // Deliberately more presses than the header has controls, so this also
    // observes where Tab goes next. A pad must never be one of the answers:
    // a pad owns Enter and Space for itself, so focus landing there is what
    // would make the transport keys mean something else mid-show.
    const seen = await tabThrough(page, 12);

    expect(seen).toContain("testid:search-button");
    expect(seen).toContain("testid:help-button");
    expect(seen.filter((d) => d.startsWith("id:pad-"))).toEqual([]);
  });

  test("Enter operates a control the operator tabbed to, rather than the emergency bank", async ({
    page,
  }) => {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if ((await focusedDescriptor(page)) === "testid:help-button") break;
    }
    expect(await focusedDescriptor(page)).toBe("testid:help-button");

    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Keyboard Shortcuts").first()).toBeVisible();
  });

  test("Escape hands the keyboard back to the board", async ({ page }) => {
    await page.keyboard.press("Tab");
    expect(await focusedDescriptor(page)).not.toBe("body");

    // Panic is also the way out of the chrome: an operator who tabbed away
    // needs one key that both stops the room and restores the instrument,
    // without hunting for the mouse.
    await page.keyboard.press("Escape");

    expect(await focusedDescriptor(page)).toBe("body");
  });

  test("a pointer click leaves Space meaning Fade Out All", async ({
    page,
  }) => {
    await prepareAudioContext(page);

    const fileName = "chrome-click-then-space";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);
    await pad.click();
    await expect(page.locator("text=Nothing playing")).toBeHidden();

    // A click focuses the button it hit. That must not be enough to take the
    // transport keys away from the board — only a deliberate Tab is.
    await page.getByRole("button", { name: "Toggle edit mode" }).click();
    await page.keyboard.press(" ");

    await expect(
      page
        .locator('[data-testid="active-tracks-panel"]')
        .getByText("fading out..."),
    ).toBeVisible();
  });
});
