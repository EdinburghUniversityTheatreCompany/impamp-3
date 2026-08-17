import { test, expect, type Page } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
} from "./test-helpers";

/**
 * Load a sound onto each of the first N pads and Ctrl+Click it to arm, in the
 * order given — so the queue's head is known.
 */
async function armPadsInOrder(page: Page, names: string[]) {
  for (const [index, name] of names.entries()) {
    await page
      .locator(`[data-testid="pad-drop-input-${index}"]`)
      .setInputFiles(await createTestAudioFilePath(name));
    const pad = page.locator(`[id^="pad-"][id$="-${index}"]`);
    // Ctrl+Click only arms a pad that already holds sound; on one that has not
    // picked up its configuration the modifier is ignored and the click plays.
    await expect(pad).toContainText(name);

    await page.keyboard.down("Control");
    await pad.click();
    await page.keyboard.up("Control");
    await expect(pad.locator(".text-amber-500")).toBeVisible();
  }
}

/**
 * The Play button on an armed track plays *that* track.
 *
 * It did not. Every row's button was wired to `handlePlayNext()`, which calls
 * `playNextArmedTrack()` — explicitly FIFO, always the head of the queue — while
 * `TrackItem` labelled the same button `Play ${name}` for the row it belongs to.
 * `onRemove` on the very next line already passed `track.key`, so this was a
 * wiring slip rather than a constraint.
 *
 * On a live board that means clicking the green Play on the second cue sends the
 * *first* cue out to the room, and leaves the one you meant sitting in the
 * queue. Nothing on screen says anything unexpected happened.
 */
test.describe("the armed track Play button", () => {
  test("plays the track it names, not the head of the queue", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    // Two cues, armed in a known order, with distinguishable names.
    await armPadsInOrder(page, ["arm-first", "arm-second"]);

    const panel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(panel.getByTestId("armed-track-item")).toHaveCount(2);

    // Press the second row's own button.
    await panel.getByRole("button", { name: "Play arm-second" }).click();

    // The second cue is what should be heard.
    const activePanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activePanel.getByText("arm-second")).toBeVisible();
    await expect(activePanel.getByText("arm-first")).toBeHidden();

    // And the first is still armed, untouched.
    await expect(panel.getByTestId("armed-track-item")).toHaveCount(1);
    await expect(panel.getByText("arm-first")).toBeVisible();
  });

  test("F9 still takes the head of the queue", async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    // The fix parameterises the store action the row buttons call. F9 and the
    // keyboard path go through the same action with no key, so this is here to
    // catch the FIFO contract being lost on the way through.
    await armPadsInOrder(page, ["f9-first", "f9-second"]);

    await page.keyboard.press("F9");

    const activePanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activePanel.getByText("f9-first")).toBeVisible();
  });
});
