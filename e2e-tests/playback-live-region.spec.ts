import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  activatePad,
} from "./test-helpers";

/**
 * Playback state is announced.
 *
 * The only `aria-live` or `role="status"` in the whole component tree were two
 * `role="alert"`s, on the backup reminder and the conflict resolver. Nothing
 * announced that a pad had fired, that a track had finished, that a cue was
 * armed, or that F9 had consumed one — and for a tool whose entire state is
 * "what is currently making noise", that is the state that most needs saying
 * out loud. `ArmedTracksPanel` compounded it by returning `null` when the queue
 * empties, so the panel appeared and disappeared in silence.
 *
 * The regions are deliberately not the panels themselves. `TrackItem` re-renders
 * its remaining-time readout every animation frame, and a live region wrapped
 * around that would announce a countdown forever. These carry names only.
 */
test.describe("playback is announced to assistive tech", () => {
  test("names what starts and what stops", async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const announcer = page.getByTestId("playback-announcer");
    // Present from the start: a live region added to the DOM at the same
    // moment as its content is not reliably announced.
    await expect(announcer).toBeAttached();
    await expect(announcer).toHaveAttribute("aria-live", "polite");

    const fileName = "live-region-play";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await activatePad(page, pad, "q");
    await expect(announcer).toHaveText(new RegExp(`^Playing: .*${fileName}`));

    // Escape is the panic stop, and the silence it produces is itself a
    // transition worth announcing.
    await page.keyboard.press("Escape");
    await expect(announcer).toHaveText("Playback stopped");
  });

  test("names what is armed, and says so when the queue empties", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const armed = page.getByTestId("armed-announcer");
    await expect(armed).toBeAttached();

    const fileName = "live-region-arm";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await page.keyboard.down("Control");
    await pad.click();
    await page.keyboard.up("Control");
    // The pad's name, which is what `armTrack` stores — not the sound file's,
    // which is what the Active Tracks side reports.
    await expect(armed).toHaveText(new RegExp(`^Armed: .*${fileName}`));

    // F9 consumes the cue. The panel vanishes entirely at this point, which
    // is exactly the transition that used to happen in silence.
    await page.keyboard.press("F9");
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeHidden();
    await expect(armed).toHaveText("Nothing armed");
  });
});
