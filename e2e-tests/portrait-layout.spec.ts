import { test, expect } from "@playwright/test";
import { gotoApp } from "./test-helpers";

/**
 * The board in portrait, on a phone.
 *
 * The only spec that runs on the `mobile-portrait` project, and the only one
 * that can see any of this: every other spec runs at 1280x720, where all four
 * assertions below pass trivially. That is why the desktop projects
 * `testIgnore` this file — a spec that cannot fail is worse than no spec.
 *
 * Numbers rather than screenshots: a screenshot fails on every intentional
 * style change and still cannot say whether the board is operable.
 */
test.describe("portrait layout", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("a pad is big enough to hit with a thumb", async ({ page }) => {
    const pad = page.locator('[id^="pad-"][id$="-0"]').first();
    await expect(pad).toBeVisible();

    const box = await pad.boundingBox();
    expect(box).not.toBeNull();
    // 44px is the WCAG 2.2 target-size minimum and Apple's guideline. The
    // twelve-column grid computes to roughly 17px at this width, which is
    // smaller than the pad's own label.
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("the page does not scroll sideways", async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("Stop All is the last pad in the board's visual order", async ({
    page,
  }) => {
    // By geometry, never by index. The whole point of the change is that pad
    // index 23 is *painted* last while staying index 23 — an assertion on the
    // index would pass before and after and prove nothing.
    const boxes = await page.locator('[id^="pad-"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.id, top: rect.top, left: rect.left };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);

    const last = boxes.reduce((furthest, candidate) =>
      candidate.top > furthest.top ||
      (candidate.top === furthest.top && candidate.left > furthest.left)
        ? candidate
        : furthest,
    );
    expect(last.id).toMatch(/-23$/);
  });

  test("the track panels take their own space rather than covering the board", async ({
    page,
  }) => {
    // Scrolled to the very bottom, which is where a fixed footer wins and a
    // footer in flow does not. Checked by hit-testing rather than by comparing
    // boxes: a fixed overlay leaves the pad's own rectangle untouched, so
    // geometry alone cannot tell whether anything is painted on top of it.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);

    const covered = await page.evaluate(() => {
      const pads = [...document.querySelectorAll('[id^="pad-"]')];
      return pads
        .map((pad) => {
          const rect = pad.getBoundingClientRect();
          // Only pads actually on screen; one scrolled out is not "covered".
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit && pad.contains(hit) ? null : pad.id;
        })
        .filter(Boolean);
    });

    expect(covered).toEqual([]);
  });
});
