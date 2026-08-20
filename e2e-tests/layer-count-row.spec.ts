import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  enterEditMode,
  savePadEditModal,
} from "./test-helpers";

/**
 * The stacked-pad row in Active Tracks shows its layer count *and* its
 * remaining time.
 *
 * The count used to be positioned `absolute … right-12` over the row, and it
 * landed squarely on the time: a group row that should have read `0:59`
 * rendered as `0:` with the badge covering the last two digits, while the
 * expanded child rows right below it read `0:57` in full. On a live-performance
 * soundboard the remaining time is the one number an operator most needs, and
 * a stacked pad is exactly when they need it.
 *
 * `PadTrackGroup.test.tsx` pins the arrangement — the count is a child of the
 * row and nothing takes it out of flow — but jsdom has no layout, so only a
 * real browser can say whether two boxes overlap. That distinction has bitten
 * this repo before: the bank-tab drag passed its jsdom unit test for three
 * review rounds while not working in a browser at all. So the assertion here
 * is geometric, on rectangles the engine actually laid out.
 */
test("a stacked pad's group row shows the count beside the time, not over it", async ({
  page,
}) => {
  await gotoApp(page);
  await prepareAudioContext(page);

  const fileName = "layer-me";
  await page
    .locator('[data-testid="pad-drop-input-0"]')
    .setInputFiles(await createTestAudioFilePath(fileName));
  const pad = page.locator('[id^="pad-"][id$="-0"]');
  await expect(pad).toContainText(fileName);

  await enterEditMode(page);
  await pad.click();
  await page.locator('[data-testid="edit-pad-active-behavior-layer"]').click();
  await savePadEditModal(page);

  // Five presses of a layering pad: one row, five layers.
  for (let i = 0; i < 5; i++) {
    await pad.click();
    await page.waitForTimeout(200);
  }

  const countButton = page.getByRole("button", {
    name: /^Show the 5 layers of layer-me$/,
  });
  await expect(countButton).toBeVisible();
  await expect(countButton).toHaveAttribute("aria-expanded", "false");

  const groupRow = page.locator('[data-testid="active-track-item"]').first();
  // Exactly one row while collapsed, and it carries a whole `m:ss`.
  await expect(page.locator('[data-testid="active-track-item"]')).toHaveCount(
    1,
  );
  await expect(groupRow).toHaveText(/\d+:\d\d/);

  const boxes = await page.evaluate(() => {
    const row = document.querySelector(
      '[data-testid="active-track-item"]',
    ) as HTMLElement;
    const badge = document.querySelector(
      '[data-testid="active-track-layer-count"]',
    ) as HTMLElement | null;
    // The time readout is the only element in the row whose whole text is a
    // `m:ss` — deliberately found by content, so this keeps working if the
    // markup around it moves.
    const time = Array.from(row.querySelectorAll("div")).find((d) =>
      /^\d+:\d\d$/.test(d.textContent ?? ""),
    ) as HTMLElement | undefined;
    if (!badge || !time) return null;
    const b = badge.getBoundingClientRect();
    const t = time.getBoundingClientRect();
    return {
      time: time.textContent,
      overlapX: Math.min(b.right, t.right) - Math.max(b.left, t.left),
      overlapY: Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top),
    };
  });

  expect(boxes).not.toBeNull();
  // They share the row's vertical band, as they should — so a horizontal gap
  // is the only thing keeping them apart, and it must be a real one.
  expect(boxes!.overlapY).toBeGreaterThan(0);
  expect(boxes!.overlapX).toBeLessThanOrEqual(0);

  // The interaction is unchanged: the count expands, and does not stop the pad.
  await countButton.click();
  await expect(
    page.getByRole("button", { name: /^Hide the 5 layers of layer-me$/ }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="active-track-layer-item"]'),
  ).toHaveCount(5);
});
