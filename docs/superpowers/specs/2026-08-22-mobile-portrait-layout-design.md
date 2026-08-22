# Design: a layout that works in portrait

Date: 2026-08-22
Status: awaiting review

The board is unusable on a phone. This makes it usable **as a convenience
device** — viewing, editing, checking a profile, the occasional trigger —
and deliberately not as a device you would run a show from. That decision
is Mick's and it is what bounds every section below.

---

## 0 — What the survey found

Read this first; three of the four sections exist because of it.

**The grid cannot be reached by a breakpoint.** `PadGrid.tsx` sets its
columns as an inline style:

```jsx
style={{
  gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))`,
}}
```

Inline styles carry no media queries, so no Tailwind class can override
them. Pads are `aspect-square` with no minimum, so the board does not wrap
or overflow — it shrinks. Pad edge is
`(viewportWidth − 64 [main p-8] − 32 [grid p-4] − 88 [11 × gap-2]) / 12`,
which at a 390 px phone is **roughly 17 px**, smaller than the text inside
it.

**Almost no responsive intent exists.** The complete set of width
breakpoints in `src/` is three modal/panel grids collapsing to one column
(`ActiveTracksPanel`, `ArmedTracksPanel`, `SearchModal`,
`BulkImportModalContent`, `ConflictResolutionModal`) plus some `sm:text-sm`.
There is exactly one `@media` rule in the whole of `src/`, and it is
`prefers-color-scheme`. The header, the bank strip and the board have none.

**Two viewport bugs that only show on the target devices.**

- `pb-safe` appears on both track panels and **emits no CSS**. There is no
  `tailwind.config.*`, nothing defines it in `globals.css`, and Tailwind
  4.3.3 ships no safe-area utility. Meanwhile `layout.tsx` declares
  `appleWebApp.statusBarStyle: "black-translucent"`, which means the page
  runs under the iOS status bar — so the three `fixed top-0` mode banners
  sit beneath the notch with nothing to clear it.
- Every viewport unit in the app is `vh`, never `dvh`: `min-h-screen` on
  `page.tsx`, `max-h-[20vh]`/`max-h-[15vh]` on the two track panels, and
  the modal caps. On mobile browsers `vh` is the _large_ viewport, so each
  is taller than the visible area while the browser chrome is showing.

**The footer already overflows its reservation.** `ActiveTracksPanel` is
always mounted, even when empty, and costs about 90 px of chrome plus up to
`20vh`; `ArmedTracksPanel` adds the same plus `15vh` when the queue is not
empty. The content container reserves `mb-24` — 96 px — for both.

---

## 1 — The grid reflows by column count, not by data

### The change

`GRID_COLS = 12` is doing two unrelated jobs: it is the **data** shape
(`TOTAL_PADS`, `MANUAL_ROW_START_INDEX`, and the special-pad positions
`1 * GRID_COLS + 11` and `2 * GRID_COLS + 11`) and it is also the
**painting** shape. Only the second reflows.

```jsx
<div
  className="grid gap-2 p-2 sm:p-4 grid-cols-4 md:grid-cols-6 lg:grid-cols-(--pad-cols)"
  style={{ "--pad-cols": `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
>
```

Tailwind owns the breakpoints, so the JIT can see them and they read like
the rest of the repo. The desktop count still derives from `GRID_COLS`, so
the constant stays single-sourced — which matters, because
`grid-cols-${GRID_COLS}` is invisible to the scanner and a hardcoded
`grid-cols-12` would be the same rule written twice, this repo's named
regression.

The narrow counts are hardcoded **deliberately**. 4 and 6 are presentation
and have nothing to do with the data shape; deriving them from `GRID_COLS`
would imply a relationship that does not exist.

`gridTemplateRows` is dropped. It is `repeat(4, minmax(0,1fr))` today
against `aspect-square` children in an auto-height container, where the
aspect ratio already drives row height — and a fixed four rows is exactly
wrong once the column count is not twelve.

Verified against the real compiler before being written down: Tailwind
4.3.3 emits `.lg\:grid-cols-\(--pad-cols\) { grid-template-columns:
var(--pad-cols) }`.

### The page padding reduces too

The measurement below assumes it. `page.tsx`'s root is `p-8` (64 px of
horizontal padding), which on a 390 px screen is a sixth of the width spent
on margin. It drops on narrow alongside the grid's own `p-4`; both are
restored above the breakpoint.

### Why 4 columns

Measured at a 390 px phone with both paddings reduced —
32 px page + 16 px grid + 24 px of gaps:
`(390 − 32 − 16 − 24) / 4 ≈ 79 px`, comfortably over the 44 px minimum tap
target, and wide enough that pad names stay legible. Six columns gives
about 47 px — over the minimum, but names truncate hard. Twelve rows of
scrolling is acceptable for a convenience device.

---

## 2 — Stop All and Fade Out All move to the last row

### Why not the last column

The first design kept them in the last column, which happens to work for
any portrait column count dividing both 24 and 36 (2, 3, 4, 6, 12), since
index 23 and index 35 are each one short of a multiple. Mick's objection is
the right one: on a vertically scrolling board, "the last column" is not
muscle memory. **"Scroll to the bottom" is.** Dropping that constraint also
frees the column count to be chosen purely on tap size, which is how §1
arrived at 4.

### The change

Paint order only, through Tailwind `order-*` on the two special pads,
reset above the breakpoint:

- Fade Out All (index 35) orders next-to-last
- Stop All (index 23) orders last, so it lands bottom-right under the thumb

Pad **indices do not change**. 23 and 35 are wired to `Escape` and `Space`
in `keyboardUtils.ts`, and every stored profile is keyed on pad index; a
data change here would be a migration and would break every existing board.

The visual sequence in portrait becomes 0–22, 24–34, 36–47, Fade Out, Stop
All — 48 cells in 12 rows of 4, exactly filled, no gaps.

**`order` is normally an accessibility smell**, because it desynchronises
visual order from DOM order, and both the tab sequence and a screen
reader's browse order follow the DOM. It is safe here for a specific
reason that must be written into the code comment so nobody "fixes" it:
`Pad` is `tabIndex={-1}` and CLAUDE.md records that Tab can never park
focus on the board, so there is no tab order to desynchronise.

---

## 3 — Chrome that currently assumes one line

**Header.** `page.tsx` puts a `text-4xl` title and a six-item button row
(Search, Help, Loudness, Edit, Delete/Move, ProfileSelector — each a fixed
`w-9 h-9`, plus a `max-w-[150px]` profile label) in one
`flex justify-between` row with no wrapping. Let the row wrap below the
title on narrow, and reduce the title size there.

**Bank strip.** Already `overflow-x-auto`, so it survives. Tabs are
`{number}: {name}` with no truncation and no `min-w-0`. Leave the label
format alone — `e2e-tests/bank-reorder.spec.ts` asserts on it
(`toHaveText("3: …")`).

**Footer.** Reserve the footer's real height instead of the guessed
`mb-24`, so the panels cannot cover the board on a short viewport. The
mechanism is an implementation detail for the plan; the requirement is that
the last row of pads is scrollable into view with both panels open.

---

## 4 — The viewport bugs, folded in

Folded in rather than split out because they only manifest on the devices
this phase targets, so cause and fix belong together.

- Define a real safe-area utility and use it: `env(safe-area-inset-bottom)`
  on the track panels in place of the dead `pb-safe`, and
  `env(safe-area-inset-top)` on the three `fixed top-0` mode banners plus
  `BackupReminderNotification`.
- `min-h-screen` → the dynamic-viewport equivalent on `page.tsx`, and the
  `20vh`/`15vh` panel caps likewise. Modal caps (`70vh`/`80vh`/`90vh`) move
  too — they are the same bug — but are lower risk and can be one commit.

---

## 5 — Testing

A **second Playwright project** at a phone viewport with `hasTouch: true`,
running one focused portrait spec. Not the whole suite: `playwright.config.ts`
today has no viewport set at all and inherits `devices["Desktop Chrome"]`
(1280 × 720, `hasTouch: false`), and the existing 193 specs are written
against that.

The portrait spec asserts what a reader cannot check by eye:

1. a pad's rendered box is at least 44 px on both axes
2. `document.documentElement.scrollWidth <= clientWidth` — the page does not
   scroll horizontally
3. the last pad row can be scrolled into view with both track panels open
4. Stop All is the last cell in DOM-independent visual order (compare
   bounding boxes, not indices)

Two existing constraints to respect:

- `e2e-tests/layer-count-row.spec.ts` measures bounding boxes and asserts
  the layer badge and the `m:ss` readout share a vertical band without
  overlapping horizontally. It runs at 1280 px, so it is unaffected —
  provided `TrackItem`'s internal row layout is left alone at desktop
  widths.
- 224 `toBeVisible()` assertions across 32 specs. Playwright's
  `toBeVisible` needs a non-empty box, so hiding anything behind a
  breakpoint would fail them. Nothing in this design hides an element by
  breakpoint; if the plan reaches for `hidden md:block`, that is the signal
  to check the specs first.

---

## 6 — Out of scope, and why

Recorded in `plans/off-topic-improvements.md` rather than dropped:

- **No touch route for four actions.** Play emergency sound (`Enter`), play
  next armed track (`F9`), and arming a track (Ctrl/Cmd+click) have no
  on-screen equivalent at all. Stop All and Fade Out All exist only as
  pads — there is no toolbar button for either.
- **Pad reordering is desktop-only.** `Pad.tsx` uses HTML5 drag-and-drop
  (`draggable`, `onDragStart`, `onDrop`), which does not fire on touch.
- **Bank-tab reordering by touch is untested.** `@hello-pangea/dnd`
  registers `useTouchSensor` by default and injects
  `touch-action: manipulation`, so it should work, but the strip is
  `overflow-x-auto` and scroll-versus-lift arbitration was not verified.
  `e2e-tests/bank-reorder.spec.ts` drives the _keyboard_ sensor only.
- **No `:active` state or tap-highlight suppression on pads.** Feedback is
  `hover:` only, which sticks after a tap on touch.

All four are performance-device concerns. They become worth doing if the
answer to "what is a phone for" ever changes.
