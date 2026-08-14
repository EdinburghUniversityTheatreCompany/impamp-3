import { test, expect, Page } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  activatePad,
} from "./test-helpers";

/**
 * Loudness normalisation defaults to on (see DEFAULT_NORMALISATION), which
 * mixes an analysis-derived normDb into every resolved gain. That component
 * depends on whether the background sweep has analysed the file by the time
 * the pad is triggered — timing this suite doesn't control. Turning
 * normalisation off here makes the per-sound gain the only contributor to
 * totalDb, so the audio-path assertion below is exact rather than "probably
 * close if the sweep hasn't run yet".
 *
 * Reaches the control through the Profile Manager (Profile selector →
 * "Manage Profiles"), the only place `normalisation-enabled` renders — see
 * ProfileCard.tsx, which shows the loudness section for the active profile's
 * own card only. Waiting on `not.toBeChecked()` matters here, not just
 * style: `setNormalisation` persists to IndexedDB before the store updates,
 * so the checkbox only flips once the write that
 * `getNormalisationSettings()` will observe has actually landed.
 */
async function disableNormalisation(page: Page) {
  const profileSelector = page.getByRole("button", { name: /^Profile: / });
  await profileSelector.click();
  await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeVisible();

  // Not .uncheck(): setNormalisation awaits an IndexedDB write before the
  // store (and therefore this controlled checkbox) updates, and Playwright's
  // built-in uncheck() samples the checked state too soon after the click to
  // see that land, reporting "did not change state" even though it does a
  // beat later. A plain click plus a polling assertion tolerates the delay.
  const checkbox = page.getByTestId("normalisation-enabled");
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();

  await page.getByLabel("Close").click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeHidden();
}

test.describe("loudness normalisation", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  test("opens the overview, switches tabs, sorts and filters to problems", async ({
    page,
  }) => {
    await page.getByTestId("loudness-overview-button").click();
    await expect(page.getByTestId("loudness-overview")).toBeVisible();

    // Default tab is "sounds"; switch to "pads" and confirm the tablist
    // actually moved, not just that the click landed.
    await page.getByTestId("loudness-tab-pads").click();
    await expect(page.getByRole("tab", { name: "pads" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: "sounds" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await page.getByTestId("loudness-tab-sounds").click();
    await expect(page.getByRole("tab", { name: "sounds" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Sorting by a column is a header-button click; confirm the sort
    // indicator actually appears rather than just that nothing threw.
    await page.getByTestId("loudness-sort-final").click();
    await expect(page.getByTestId("loudness-sort-final")).toContainText("↓");

    await page.getByTestId("loudness-problems-only").check();
    await expect(page.getByTestId("loudness-problems-only")).toBeChecked();
  });

  test("a raised per-sound gain persists and reaches the audio path", async ({
    page,
  }) => {
    await disableNormalisation(page);

    const filePath = await createTestAudioFilePath("loudnessGainSound");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [filePath]);

    const slider = page.getByTestId(/^edit-pad-gain-sound-/).first();
    const testIdAttr = await slider.getAttribute("data-testid");
    const audioFileId = Number(testIdAttr!.replace("edit-pad-gain-sound-", ""));
    expect(Number.isNaN(audioFileId)).toBe(false);

    // <input type="range"> can't be driven with .fill() (Playwright rejects
    // it for non-text input types), so nudge it with the keyboard instead —
    // a real user interaction, and step=0.5 makes 12 presses exactly +6 dB.
    await slider.focus();
    for (let i = 0; i < 12; i++) {
      await slider.press("ArrowRight");
    }
    await expect(page.getByTestId(`${testIdAttr}-value`)).toHaveText("+6.0");

    await savePadEditModal(page);

    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await activatePad(page, pad);

    const resolved = await page.evaluate(
      () =>
        (
          window as unknown as {
            __impampLastResolvedGain?: {
              audioFileId: number;
              totalDb: number;
            };
          }
        ).__impampLastResolvedGain,
    );

    expect(resolved).toBeTruthy();
    expect(resolved!.audioFileId).toBe(audioFileId);
    // Normalisation is off, so totalDb is exactly the sound's manual gain
    // (padGainDb is untouched at 0) — not just "greater than 5".
    expect(resolved!.totalDb).toBeCloseTo(6, 5);
  });
});
