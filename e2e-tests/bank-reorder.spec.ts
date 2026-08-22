import { test, expect, type Page } from "@playwright/test";
import {
  bankDragHandle,
  bankTabs,
  createTestAudioFilePath,
  gotoApp,
  keyboardDragTab,
  latchEditMode,
  prepareAudioContext,
  unlatchEditMode,
  waitForAppReady,
} from "./test-helpers";

/**
 * End-to-end cover for reordering the bank tabs.
 *
 * Everything here drives `@hello-pangea/dnd`'s KEYBOARD sensor rather than the
 * mouse: a pointer drag against a horizontal list, mid-animation, is the
 * flakiest thing this suite could contain, and the library gives the keyboard
 * path for free (focus the handle, Space to lift, arrows to move, Space to
 * drop, Escape to cancel).
 *
 * That also makes this the first test anywhere in the repo that exercises the
 * real library. The three bugs fixed on this branch — Escape mid-drag hitting
 * the panic button, Space fading every sound out, Enter firing an emergency
 * cue — all came from dnd binding those keys on `window` with `capture: true`
 * and preventDefault-ing them, and are otherwise covered only by a jsdom test
 * that *simulates* that capture-phase preventDefault. The last test in this
 * file listens for the real thing.
 */

/**
 * The bank NAME shown at a position, with the position prefix stripped.
 *
 * The tab renders `${position + 1}: ${bank.name}`, so the prefix moves with
 * the slot while the name moves with the bank — which is exactly the
 * distinction every test here is about. The shape is asserted rather than
 * assumed, so a change to the label format fails loudly instead of silently
 * comparing the wrong half.
 */
async function bankNameAt(page: Page, position: number): Promise<string> {
  const label = (await bankTabs(page).nth(position).innerText()).trim();
  const match = /^(\d+):\s*(.+)$/.exec(label);
  expect(
    match,
    `bank tab ${position} should be labelled "<number>: <name>", got ${JSON.stringify(label)}`,
  ).not.toBeNull();
  return match![2].trim();
}

test.describe("Bank reorder", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("a dragged tab keeps its name and its selection at its new position", async ({
    page,
  }) => {
    const tabs = bankTabs(page);

    // Select the bank that is about to be dragged, so the test can tell
    // "the view follows the bank" from "the view follows the slot".
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    const moved = await bankNameAt(page, 1);
    const displaced = await bankNameAt(page, 2);
    expect(moved).not.toBe(displaced);

    await latchEditMode(page);
    await keyboardDragTab(page, 1, "ArrowRight");

    // The two banks swapped slots, name for name...
    await expect(tabs.nth(2)).toContainText(moved);
    await expect(tabs.nth(1)).toContainText(displaced);
    // ...and the number prefix stayed with the slot, not the bank.
    expect(await bankNameAt(page, 2)).toBe(moved);
    await expect(tabs.nth(2)).toHaveText(`3: ${moved}`);

    // The selection travelled with the bank, because it is keyed by bank id
    // and not by position.
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  });

  test("the hotkey selects whatever now occupies the position", async ({
    page,
  }) => {
    const tabs = bankTabs(page);
    const first = await bankNameAt(page, 0);
    const second = await bankNameAt(page, 1);

    await latchEditMode(page);
    await keyboardDragTab(page, 0, "ArrowRight");

    // Order is now [second, first, ...].
    await expect(tabs.nth(0)).toContainText(second);
    await expect(tabs.nth(1)).toContainText(first);

    await unlatchEditMode(page);

    // The digit addresses the POSITION, so "1" now selects the bank that was
    // in slot 2 a moment ago.
    await page.keyboard.press("1");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveText(`1: ${second}`);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");

    // And "2" reaches the bank that used to answer to "1".
    await page.keyboard.press("2");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toHaveText(`2: ${first}`);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");
  });

  test("the new order survives a reload", async ({ page }) => {
    const tabs = bankTabs(page);
    const first = await bankNameAt(page, 0);
    const second = await bankNameAt(page, 1);

    await latchEditMode(page);
    await keyboardDragTab(page, 1, "ArrowLeft");

    // Wait for the new order on screen before reloading: the strip only
    // re-renders once reorderBanks has resolved, so this is also what proves
    // the write landed rather than racing the reload.
    await expect(tabs.nth(0)).toContainText(second);
    await expect(tabs.nth(1)).toContainText(first);

    await page.reload();
    await waitForAppReady(page);

    await expect(bankTabs(page).nth(0)).toHaveText(`1: ${second}`);
    await expect(bankTabs(page).nth(1)).toHaveText(`2: ${first}`);
  });

  test("dragging a tab with the keyboard leaves playing audio alone", async ({
    page,
  }) => {
    await prepareAudioContext(page);

    // A clip long enough to outlive the three-second fade the Space bug used
    // to start, but small enough to cross into the page quickly.
    const soundName = "reorder-keeps-playing";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(soundName, 30));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(soundName);

    await pad.click();
    const activePanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activePanel.getByText(soundName)).toBeVisible();

    const tabs = bankTabs(page);
    const moved = await bankNameAt(page, 1);
    await latchEditMode(page);

    // Cancelling a drag with Escape used to reach the panic button and stop
    // every sound outright, so this assertion needs no wait to be meaningful.
    // Through the drag handle, not the bare tab: before the drag chunk lands
    // this Space is not a cancelled lift at all, it is the global fade-out.
    await (await bankDragHandle(page, 1)).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(activePanel.getByText(soundName)).toBeVisible();
    await expect(tabs.nth(1)).toContainText(moved);

    // Now a real lift and drop. Space used to start a three-second fade out.
    await keyboardDragTab(page, 1, "ArrowRight");
    await expect(tabs.nth(2)).toContainText(moved);

    // Outlast that fade before believing the sound survived it.
    await page.waitForTimeout(4000);
    await expect(activePanel.getByText(soundName)).toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeHidden();
  });
});
