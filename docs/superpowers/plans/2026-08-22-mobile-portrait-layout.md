# Mobile / portrait layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the soundboard legible and usable in portrait on a phone, as a convenience device rather than a performance one.

**Architecture:** The pad grid's column count becomes a Tailwind breakpoint concern while `GRID_COLS` stays the data shape; the two transport pads move to the end of the scroll with CSS `order`; the header wraps; the footer joins normal flow so it cannot cover the board; and the safe-area and `dvh` bugs that only appear on these devices are fixed alongside.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS 4.3 (no config file — `@utility` in `globals.css`), Playwright 1.62.

**Spec:** `docs/superpowers/specs/2026-08-22-mobile-portrait-layout-design.md`

## Global Constraints

- **Pad indices never change.** `SPECIAL_PAD_CONFIG.STOP_ALL.index` (23) and `FADE_OUT_ALL.index` (35) are wired to `Escape` and `Space` in `keyboardUtils.ts` and every stored profile is keyed on pad index. This work is paint-order only.
- **`GRID_COLS` stays 12** and stays the source of the desktop column count. Never hardcode `grid-cols-12`.
- **The machine is resource-constrained.** Run e2e with `--workers=1` and, while iterating, `--project=mobile-portrait` only. Never treat a piped `tail`/`grep` as the verdict: redirect to a file and echo `$?`. A passing run prints almost nothing, so check the test count.
- **Never run `npm run dev` on port 3000** — one may already be running.
- Existing gates must stay green: `npx vitest run`, `npm run typecheck`, `npm run lint`, `npx prettier --check .`, `bash scripts/run-jscpd.sh javascript,typescript,css,scss`.
- Commit messages: `type(scope): lowercase sentence`, blank line, prose body explaining _why_. End every message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File                                                                          | Responsibility after this plan                                                                                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`                                                        | Adds a second project, `mobile-portrait`, at a phone viewport with touch. Desktop `chromium` is untouched and remains what CI gates on.                                     |
| `e2e-tests/portrait-layout.spec.ts`                                           | **New.** The only spec that runs on the mobile project. Asserts tap size, no horizontal scroll, the transport pads' position, and that the footer does not cover the board. |
| `src/app/globals.css`                                                         | Gains two `@utility` rules for safe-area padding — the app has no `tailwind.config.*`, so this is where a custom utility lives in Tailwind 4.                               |
| `src/components/PadGrid.tsx`                                                  | Column count moves from an inline style to Tailwind classes plus a `--pad-cols` custom property; the two transport pads gain `order-*`.                                     |
| `src/app/page.tsx`                                                            | Header wraps; page padding reduces on narrow; `min-h-screen` becomes dynamic-viewport; the three mode banners clear the notch; the footer joins normal flow.                |
| `src/components/ActiveTracksPanel.tsx`, `src/components/ArmedTracksPanel.tsx` | Dead `pb-safe` replaced with a real utility; `vh` caps become `dvh`.                                                                                                        |

---

### Task 1: The mobile project and a spec that fails today

This comes first so every later task has a test bed. All four assertions fail against the current layout.

**Files:**

- Modify: `playwright.config.ts` (the `projects` array, around line 78)
- Create: `e2e-tests/portrait-layout.spec.ts`

**Interfaces:**

- Consumes: `gotoApp` from `e2e-tests/test-helpers.ts`
- Produces: a Playwright project named `mobile-portrait`; later tasks run `npx playwright test --project=mobile-portrait --workers=1`

- [ ] **Step 1: Add the mobile project**

In `playwright.config.ts`, import `devices` is already present. Add as the **last** entry of `projects`, after `webkit`:

```ts
    // A phone, in portrait, with touch — the only project `portrait-layout.spec.ts`
    // runs on. Deliberately not a fourth full-suite browser: the other 190-odd
    // specs are written against `devices["Desktop Chrome"]` (1280x720, no
    // touch), and running them at 390px would be asserting a layout nobody
    // designed. CI still gates on chromium alone.
    {
      name: "mobile-portrait",
      use: { ...devices["Pixel 7"] },
      testMatch: /portrait-layout\.spec\.ts/,
    },
```

Then exclude that spec from the desktop projects so it does not run at 1280px, by adding to the `chromium`, `firefox` and `webkit` entries:

```ts
      testIgnore: /portrait-layout\.spec\.ts/,
```

- [ ] **Step 2: Write the failing spec**

Create `e2e-tests/portrait-layout.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { gotoApp } from "./test-helpers";

/**
 * The board in portrait, on a phone.
 *
 * These assert the things a reader cannot check by eye and that no other spec
 * can see: every other spec runs at 1280x720, where all four of these pass
 * trivially. Numbers rather than screenshots, because a screenshot test would
 * fail on every deliberate style change and tell us nothing about whether the
 * board is usable.
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
    // 44px is the WCAG 2.2 / iOS minimum target. The current 12-column grid
    // computes to roughly 17px at this width.
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
    // By geometry, not by index: the point of the change is that index 23 is
    // painted last, so asserting on the index would pass either way.
    const boxes = await page.locator('[id^="pad-"]').evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.id, top: r.top, left: r.left };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    const last = boxes.reduce((a, b) =>
      b.top > a.top || (b.top === a.top && b.left > a.left) ? b : a,
    );
    expect(last.id).toMatch(/-23$/);
  });

  test("the track panels do not cover the last row of pads", async ({
    page,
  }) => {
    const pad23 = page.locator('[id^="pad-"][id$="-23"]');
    await pad23.scrollIntoViewIfNeeded();
    const covered = await page.evaluate(() => {
      const pad = document.querySelector('[id^="pad-"][id$="-23"]');
      if (!pad) return "no pad";
      const r = pad.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return pad.contains(hit) ? "visible" : "covered";
    });
    expect(covered).toBe("visible");
  });
});
```

- [ ] **Step 3: Run it and confirm all four fail**

```bash
E2E_PORT=3191 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-t1.log 2>&1; echo $?
```

Expected: exit 1, 4 failed. The tap-size assertion should report a width around 17px. Read `/tmp/p5-t1.log`; do not pipe it.

- [ ] **Step 4: Confirm the desktop suite is unaffected**

```bash
E2E_PORT=3192 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t1b.log 2>&1; echo $?
```

Expected: exit 0, the same count as before this task (the new spec must be ignored by the desktop projects).

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e-tests/portrait-layout.spec.ts
git commit
```

Message: `test(e2e): measure the board at phone width, where it does not fit` — body explains that all four assertions fail today and why they are numbers rather than screenshots.

---

### Task 2: Safe-area utilities, replacing a class that emits nothing

**Files:**

- Modify: `src/app/globals.css`
- Modify: `src/components/ActiveTracksPanel.tsx:95`, `src/components/ArmedTracksPanel.tsx:73`
- Modify: `src/app/page.tsx` (the three `fixed top-0` banners at lines ~176, ~182, ~195)

**Interfaces:**

- Produces: Tailwind utilities `pb-safe` and `pt-safe`, usable anywhere.

- [ ] **Step 1: Prove `pb-safe` currently emits nothing**

```bash
grep -rn "pb-safe" src/ && grep -rn "safe" src/app/globals.css; echo "---"; ls tailwind.config.* 2>/dev/null || echo "no tailwind config"
```

Expected: `pb-safe` used in two components, defined nowhere, and no config file. That is the finding — the class is inert.

- [ ] **Step 2: Define the utilities**

Append to `src/app/globals.css`:

```css
/**
 * Safe-area padding, which Tailwind 4 does not ship and this app needs.
 *
 * `pb-safe` was already in use on both track panels and emitted no CSS at all
 * — there is no `tailwind.config.*` here and nothing defined it, so it was a
 * class name doing nothing. `pt-safe` matters because `layout.tsx` declares
 * `appleWebApp.statusBarStyle: "black-translucent"`, which runs the page
 * underneath the iOS status bar: without it the fixed mode banners sit under
 * the notch.
 *
 * `max()` rather than the bare inset so these are no-ops on every device that
 * reports zero, which is all of them except a notched phone in a PWA.
 */
@utility pb-safe {
  padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
}

@utility pt-safe {
  padding-top: max(0.25rem, env(safe-area-inset-top));
}
```

- [ ] **Step 3: Apply `pt-safe` to the three banners**

In `src/app/page.tsx`, on each of the three `fixed top-0` divs (edit mode, delete/move mode, read-only), replace `py-1` with `pb-1 pt-safe`.

- [ ] **Step 4: Verify the utility now emits CSS**

```bash
npx prettier --check src/app/globals.css && npx vitest run > /tmp/p5-t2.log 2>&1; echo $?
```

Then confirm the class is real by compiling: the `mobile-portrait` run in Task 1 still fails on the same four assertions (this task fixes none of them), but nothing new breaks.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/components/ActiveTracksPanel.tsx src/components/ArmedTracksPanel.tsx src/app/page.tsx
git commit
```

Message: `fix(layout): give pb-safe a definition, and clear the notch` — body records that the class had been inert since it was written.

---

### Task 3: Dynamic viewport units

**Files:**

- Modify: `src/app/page.tsx:172` (`min-h-screen`)
- Modify: `src/components/ActiveTracksPanel.tsx:95` (`max-h-[20vh]`), `src/components/ArmedTracksPanel.tsx:73` (`max-h-[15vh]`)

- [ ] **Step 1: Find every `vh` in the app**

```bash
grep -rn "vh\]" src/ | grep -v ".test." > /tmp/p5-vh.txt; cat /tmp/p5-vh.txt
```

- [ ] **Step 2: Change the three that govern the board**

- `page.tsx:172`: `min-h-screen` → `min-h-dvh`
- `ActiveTracksPanel.tsx:95`: `max-h-[20vh]` → `max-h-[20dvh]`
- `ArmedTracksPanel.tsx:73`: `max-h-[15vh]` → `max-h-[15dvh]`

Leave the modal caps (`70vh`/`80vh`/`90vh`) for Step 3 so this commit is about the board.

- [ ] **Step 3: Change the modal caps in a second pass**

Every remaining hit in `/tmp/p5-vh.txt` — `HelpModalContent`, `LoudnessOverviewModalContent`, `ConflictResolutionModal`, `SearchModal`, `BulkImportModalContent`, `ProfileManager`, `Modal.tsx` — from `vh` to `dvh`. Same bug, lower risk.

- [ ] **Step 4: Verify**

```bash
npx vitest run > /tmp/p5-t3.log 2>&1; echo $?
E2E_PORT=3193 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t3b.log 2>&1; echo $?
```

Expected: both exit 0, counts unchanged.

- [ ] **Step 5: Commit** (two commits — the board, then the modals)

Messages: `fix(layout): measure the board against the visible viewport, not the large one` and `fix(modals): the same dvh correction, for every modal cap`.

---

### Task 4: The grid reflows by column count

This is the task that makes the tap-size and horizontal-scroll assertions pass.

**Files:**

- Modify: `src/components/PadGrid.tsx:485-489`
- Modify: `src/app/page.tsx:172` (page padding)

**Interfaces:**

- Consumes: `GRID_COLS` from `src/lib/constants.ts` (unchanged, still 12)

- [ ] **Step 1: Replace the inline grid style**

`src/components/PadGrid.tsx`, at the grid `<div>`:

```tsx
      <div
        className="grid gap-2 p-2 sm:p-4 grid-cols-4 md:grid-cols-6 lg:grid-cols-(--pad-cols) bg-gray-50 dark:bg-gray-900 rounded-lg shadow"
        style={
          {
            // The desktop count, still derived from the constant that defines
            // the data shape. It cannot be a Tailwind class: `grid-cols-${GRID_COLS}`
            // is invisible to the JIT scanner, and a hardcoded `grid-cols-12`
            // would be the same rule written twice — this repo's characteristic
            // regression. The narrow counts above ARE hardcoded, deliberately:
            // 4 and 6 are presentation and have nothing to do with `GRID_COLS`.
            "--pad-cols": `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          } as React.CSSProperties
        }
      >
```

Delete `gridTemplateRows` entirely: the children are `aspect-square`, so the aspect ratio already drives row height, and a fixed four rows is wrong the moment the column count is not twelve. `GRID_ROWS` stays in `constants.ts` — `TOTAL_PADS` is derived from it.

- [ ] **Step 2: Reduce the page padding on narrow**

`src/app/page.tsx:172`: `p-8 pb-0` → `p-4 pb-0 sm:p-8 sm:pb-0`.

- [ ] **Step 3: Run the portrait spec**

```bash
E2E_PORT=3194 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-t4.log 2>&1; echo $?
```

Expected: the tap-size and horizontal-scroll tests now PASS; the Stop All and footer tests still FAIL. Read the file and confirm the reported pad width is around 75-80px.

- [ ] **Step 4: Confirm desktop is unchanged**

```bash
E2E_PORT=3195 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t4b.log 2>&1; echo $?
```

Expected: exit 0, count unchanged. Desktop still paints 12 columns.

- [ ] **Step 5: Commit**

```bash
git add src/components/PadGrid.tsx src/app/page.tsx
git commit
```

Message: `feat(layout): let the pad grid reflow to the width it has` — body must record the measured before/after pad size and why the desktop count stays derived.

---

### Task 5: The transport pads move to the end of the scroll

**Files:**

- Modify: `src/components/PadGrid.tsx` (the two special-pad branches, around lines 366 and 392)

- [ ] **Step 1: Add the order classes**

Both special pads are rendered through `Pad`, which accepts a `className`. In the `STOP_ALL` branch add `className="order-[9999] lg:order-none"`; in the `FADE_OUT_ALL` branch add `className="order-[9998] lg:order-none"`. If `Pad` does not already merge an incoming `className` into its `clsx(...)` call, add that first — check `src/components/Pad.tsx:210` — and keep the merge last so a caller can override.

Above the two branches, one comment:

```tsx
// Paint order only, and only in portrait. On a board you scroll down,
// "the last column" is not muscle memory — "scroll to the bottom" is —
// so the two transport pads move to the end, Stop All last so it lands
// bottom-right under the thumb. Their INDICES do not change: 23 and 35
// are wired to Escape and Space in keyboardUtils.ts and every stored
// profile is keyed on pad index.
//
// `order` normally desynchronises visual order from DOM order, which
// breaks tab sequence and screen-reader browse order. It is safe here
// for one specific reason: `Pad` is tabIndex={-1} and Tab can never park
// focus on the board (see CLAUDE.md), so there is no tab order to
// desynchronise. Do not "fix" this by removing it.
```

- [ ] **Step 2: Run the portrait spec**

```bash
E2E_PORT=3196 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-t5.log 2>&1; echo $?
```

Expected: the Stop All test now PASSES; only the footer test still fails.

- [ ] **Step 3: Confirm desktop order is untouched**

The desktop projects have a spec that finds the Stop All pad — check `e2e-tests/` for it. Run the full chromium suite:

```bash
E2E_PORT=3197 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t5b.log 2>&1; echo $?
```

Expected: exit 0, count unchanged.

- [ ] **Step 4: Commit**

Message: `feat(layout): put the transport pads where the scroll ends`.

---

### Task 6: The footer stops covering the board

`mb-24` reserves 96px for a footer that is two always-mounted panels costing about 90px of chrome each plus up to `20dvh` and `15dvh` of scroll area.

**Files:**

- Modify: `src/app/page.tsx:235` (`mb-24`) and `:378` (the `fixed bottom-0` wrapper)

- [ ] **Step 1: Move the footer into normal flow**

Replace `fixed bottom-0 left-0 right-0 z-50` with `sticky bottom-0 z-50 w-full`, and remove `mb-24` from the content container at line 235.

`sticky` keeps the panels pinned to the bottom of the viewport while the page scrolls — the behaviour `fixed` gave — but the element still occupies its own height in flow, so it cannot overlap the board and there is no guessed reservation to keep in step.

- [ ] **Step 2: Run the portrait spec — all four should now pass**

```bash
E2E_PORT=3198 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-t6.log 2>&1; echo $?
```

Expected: exit 0, 4 passed.

If the footer test still fails, the cause is almost certainly an ancestor with `overflow` set, which disables sticky. Check `page.tsx`'s `<main>` and `ClientLayout`; if an `overflow` rule is genuinely needed, fall back to keeping `fixed` and giving the content container `pb-[calc(20dvh+15dvh+11rem)]`, and say in the commit message why sticky was rejected.

- [ ] **Step 3: Confirm desktop is unchanged**

```bash
E2E_PORT=3199 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t6b.log 2>&1; echo $?
```

Expected: exit 0, count unchanged. Pay attention to `e2e-tests/layer-count-row.spec.ts`, which measures bounding boxes in the Active Tracks row — it runs at 1280px and should be unaffected, but it is the one spec that would notice a footer change.

- [ ] **Step 4: Commit**

Message: `fix(layout): let the track panels take the room they actually use`.

---

### Task 7: The header stops assuming one line

**Files:**

- Modify: `src/app/page.tsx:202-228`

- [ ] **Step 1: Let the row wrap**

Line 203: `flex justify-between items-center` → `flex flex-wrap justify-between items-center gap-2`.
Line 204: `text-4xl` → `text-2xl sm:text-4xl`.
Line 209 (the button row): `flex items-center space-x-4` → `flex flex-wrap items-center gap-2 sm:gap-4`.

`space-x-*` is replaced by `gap-*` deliberately: `space-x` sets a left margin on every child but the first, which is wrong once the row wraps — the first item of the second line loses its spacing.

- [ ] **Step 2: Verify no horizontal overflow and nothing regressed**

```bash
E2E_PORT=3200 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-t7.log 2>&1; echo $?
E2E_PORT=3201 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-t7b.log 2>&1; echo $?
```

Expected: both exit 0.

- [ ] **Step 3: Look at it**

Build and serve on a free port, then take a screenshot at 390x844 and at 1280x720, and actually look at both. A layout task verified only by numbers is half-verified.

```bash
npm run build > /tmp/p5-build.log 2>&1; echo $?
PORT=3202 npm start > /tmp/p5-serve.log 2>&1 &
```

Then use the `playwright-cli` skill, or a short Playwright script, to capture both viewports. Report what you saw. Stop the server afterwards.

- [ ] **Step 4: Commit**

Message: `fix(layout): let the header wrap instead of overflowing`.

---

### Task 8: Record what was deliberately left out

**Files:**

- Modify: `plans/off-topic-improvements.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the out-of-scope entries**

Add one entry to `plans/off-topic-improvements.md` in the file's established voice (what, where, why it matters, and what was noticed while doing what), covering all four items from §6 of the spec: the four actions with no touch route (emergency sound / `Enter`, next armed track / `F9`, arming / Ctrl+click, and no toolbar button for Stop All or Fade Out); pad reordering being HTML5 drag-and-drop and therefore desktop-only; bank-tab touch reordering being untested; and pads having no `:active` state or tap-highlight suppression.

- [ ] **Step 2: Document the layout in CLAUDE.md**

Add a bullet under the Component Architecture section recording that the grid's column count is a breakpoint concern while `GRID_COLS` is the data shape, that the transport pads are moved by `order` in portrait and why that is safe, and that `mobile-portrait` is a second Playwright project running one spec.

- [ ] **Step 3: Run every gate**

```bash
npx vitest run > /tmp/p5-final-unit.log 2>&1; echo $?
npm run typecheck; npm run lint; npx prettier --check .
bash scripts/run-jscpd.sh javascript,typescript,css,scss
E2E_PORT=3203 npx playwright test --project=chromium --workers=1 --reporter=line > /tmp/p5-final-desktop.log 2>&1; echo $?
E2E_PORT=3204 npx playwright test --project=mobile-portrait --workers=1 --reporter=line > /tmp/p5-final-mobile.log 2>&1; echo $?
```

- [ ] **Step 4: Commit**

Message: `docs: record the portrait layout, and what it deliberately leaves out`.

---

## Self-Review

**Spec coverage.** §1 grid reflow → Task 4. §1 page padding → Task 4 Step 2. §2 transport pads → Task 5. §3 header → Task 7; bank strip → no task needed (already `overflow-x-auto`, and the spec says leave the label format alone); footer → Task 6. §4 safe-area → Task 2; `dvh` → Task 3. §5 testing → Task 1. §6 out-of-scope → Task 8. No gaps.

**Placeholders.** None: every code step carries the actual class strings and the actual spec source.

**Type consistency.** The only new identifiers are the CSS utilities `pb-safe`/`pt-safe` (Task 2, used in Task 2), the custom property `--pad-cols` (defined and consumed in Task 4), and the Playwright project name `mobile-portrait` (defined in Task 1, used by name in Tasks 1, 4, 5, 6, 7, 8). All consistent.

**One risk worth naming.** Task 6's `sticky` depends on no ancestor having `overflow` set. Step 2 names the symptom, the check, and the fallback, so an executor cannot get stuck there.
