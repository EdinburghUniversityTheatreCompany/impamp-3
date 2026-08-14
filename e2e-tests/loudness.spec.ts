import { test, expect, Page, Locator } from "@playwright/test";
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

/**
 * Locates a just-added sound's own gain slider inside the edit-pad modal by
 * the sound's (unique) file name, and nudges it by `steps` × 0.5 dB via the
 * keyboard — <input type="range"> rejects Playwright's .fill().
 */
async function nudgeSoundGain(page: Page, soundName: string, steps: number) {
  const item = page
    .locator('[data-testid^="edit-pad-sound-item-"]')
    .filter({ hasText: soundName });
  // Scoped to the <input> itself: a testid *prefix* match also catches the
  // "-value" <span> GainControl renders next to the slider.
  const slider = item.locator('input[data-testid^="edit-pad-gain-sound-"]');
  await slider.focus();
  const key = steps >= 0 ? "ArrowRight" : "ArrowLeft";
  for (let i = 0; i < Math.abs(steps); i++) {
    await slider.press(key);
  }
}

/** Text of each row's "Sound" column, in the order the table renders them. */
async function soundColumnOrder(rows: Locator): Promise<string[]> {
  return rows.locator("td:nth-child(2)").allTextContents();
}

test.describe("loudness normalisation", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  test("opens the overview and switches tabs", async ({ page }) => {
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
  });

  test("sorts and filters rows built from real pad data", async ({ page }) => {
    // Two sounds on one pad with deliberately different manual gains — one
    // sound can't demonstrate sorting (there's nothing to put it in order
    // relative to), and sorting by "soundGain" is deterministic regardless
    // of whether the background analysis sweep has measured either file yet,
    // since sortValue("soundGain") reads soundGainDb directly rather than
    // anything analysis-derived.
    const [highPath, lowPath] = await Promise.all([
      createTestAudioFilePath("loudnessSortHigh"),
      createTestAudioFilePath("loudnessSortLow"),
    ]);

    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [highPath, lowPath]);
    // +12 dB (24 × 0.5 dB steps — the top of the slider's range) on one
    // sound, the other left at its default 0. This pair isn't chosen for
    // the raw manual-gain gap between them — it's chosen for what each
    // becomes once normalisation and analysis are both applied, further
    // down: see the comment above the "problems only" assertion.
    await nudgeSoundGain(page, "loudnessSortHigh", 24);
    await savePadEditModal(page);

    await page.getByTestId("loudness-overview-button").click();
    await expect(page.getByTestId("loudness-overview")).toBeVisible();

    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(2);

    // First click on a not-yet-active sort key selects it and sorts
    // descending (see toggleSort in LoudnessOverviewModalContent), so the
    // higher soundGainDb should render first.
    await page.getByTestId("loudness-sort-soundGain").click();
    await expect
      .poll(() => soundColumnOrder(rows))
      .toEqual([
        expect.stringContaining("loudnessSortHigh"),
        expect.stringContaining("loudnessSortLow"),
      ]);

    // Clicking the same key again flips the direction; the order should
    // genuinely reverse, not just redraw.
    await page.getByTestId("loudness-sort-soundGain").click();
    await expect
      .poll(() => soundColumnOrder(rows))
      .toEqual([
        expect.stringContaining("loudnessSortLow"),
        expect.stringContaining("loudnessSortHigh"),
      ]);

    // The background analysis sweep measures both sounds well within the
    // time this test has already taken opening the modal, saving and
    // sorting. Waiting out the "analysing…" marker makes that explicit and
    // removes the dependency on how fast a given machine happens to be,
    // rather than assuming it.
    await expect(page.getByText("analysing…")).toHaveCount(0);

    // Normalisation is on by default (DEFAULT_NORMALISATION.enabled), and
    // for a quiet sine wave like the test fixture it has ample peak
    // headroom to pull measured loudness all the way to the target
    // uncapped — see resolveGain in gain.ts. So once measured, finalLufs
    // converges close to target regardless of the sound's own measured
    // level, and manualDb is added on top of that, not blended into it:
    // the 0 dB sound ends up within a fraction of a dB of target (not a
    // problem), while the +12 dB sound ends up ~12 dB off target (a
    // problem, past the 3 dB threshold in filterProblemRows). So
    // "problems only" should keep exactly the loud one.
    await page.getByTestId("loudness-problems-only").check();
    await expect(rows).toHaveCount(1);
    await expect(rows.locator("td:nth-child(2)")).toContainText(
      "loudnessSortHigh",
    );

    // And unchecking brings both rows straight back — the filter is a view,
    // not a destructive action.
    await page.getByTestId("loudness-problems-only").uncheck();
    await expect(rows).toHaveCount(2);
  });

  test("a raised per-sound gain persists and reaches the audio path", async ({
    page,
  }) => {
    await disableNormalisation(page);

    const filePath = await createTestAudioFilePath("loudnessGainSound");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [filePath]);

    // input[...], not getByTestId(/^edit-pad-gain-sound-/): that regex also
    // matches the "-value" <span> GainControl renders beside the slider.
    const slider = page
      .locator('input[data-testid^="edit-pad-gain-sound-"]')
      .first();
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
