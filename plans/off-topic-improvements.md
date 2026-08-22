# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

Deferred dependency upgrades live in `plans/deferred-upgrades.md`, not here.

## Inline SVG icons should live in their own files

Thirty-one hand-written `<svg>` blocks across fifteen components, none of them
shared until `src/components/shared/ChevronDownIcon.tsx` — which exists only
because the disclosure chevron was about to become a third copy of the same
path data. The worst offenders:

```
src/app/drive/open/page.tsx                    7
src/components/profiles/ProfileManager.tsx     5
src/components/shared/TrackItem.tsx            4
src/components/profiles/ProfileSelector.tsx    3
```

They are unmaintainable in the ordinary way — the same glyph drifts between
copies, sizes and colours are set inconsistently, and `aria-hidden` is present
on some and missing on others — and they bloat the components they sit in:
seven of them are most of what `drive/open/page.tsx` contains that isn't logic.

The project has no icon library and no sprite, so this is a real decision
rather than a mechanical sweep. Roughly in order of preference:

1. Add an icon library (`lucide-react` is the obvious fit for this stack) and
   delete the hand-written paths outright.
2. Move each glyph to a `.svg` file under `src/components/icons/` and import
   it — Next's SVGR support makes them components, so call sites barely change.
3. Failing both, at least finish what `ChevronDownIcon` starts: one component
   per glyph in a shared `icons/` directory, so each path is written once.

Whichever route, do it in one pass — a half-converted icon set is worse than
either end state. Noticed while adding the sync status chip, where the
`dev-hooks` inline-svg hook flagged the new markup and the honest answer was
"the whole codebase does this".

## ProfileManager's missing-audio repair list can read "Bank Bank 3"

Task 13's brief specified rendering the missing-audio repair entries as
`Bank {entry.bankName}` (`src/components/profiles/ProfileManager.tsx`, the
`handleReplaceMissingFile`/repair-list JSX around line 1470). `entry.bankName`
already comes pre-formatted from `findMissingAudioFiles` in `src/lib/db.ts`
(`` `Bank ${convertIndexToBankNumber(position)}` `` for any bank that was
never custom-named), so an un-renamed bank shows "Bank Bank 3" in the UI. A
custom-named bank ("Act 1 SFX") reads fine; only the default-named case is
odd. Implemented exactly as briefed since it was an explicit instruction, not
a judgment call — but the fix, if wanted, is to drop the literal "Bank "
prefix and render `{entry.bankName}` alone, since the name already carries it
when there is no custom name.

Noticed while implementing Task 13 (bank identity components).

## The duplicate-audio panel names no sounds

`DuplicateAudioPanel` reports a group count, a copy count and a byte total,
because that is all `DuplicateAudioGroup` carries — `hash`, `canonicalId`,
`duplicateIds`, `reclaimableBytes`. Before deleting audio it would be better to
show _which_ sounds, the way the Missing Audio Files section lists its pads:
"horn.wav / horn (1).wav — 2 copies, 1.4 MB".

The names are in the `audioFiles` rows the scan already opens a cursor over, so
this is a field on the group rather than a second pass — but adding one changes
the interface Task 5 pinned with eight tests, which is why it was left out of
Task 7 rather than bolted on.

Noticed while building the duplicate-audio panel (Task 7 of the audio-dedup
plan).

## A radio group's validation error is rendered twice

All four `RadioGroup` sites pass the same `error` to the wrapping `FormField`
as well as to the group itself — `EditPadForm.tsx:337,359`,
`ProfileEditForm.tsx:76`, `PlaybackSettingsForm.tsx:55` — and both components
render it in their own `<p>`. A validation failure on one of these groups
therefore shows the same sentence twice, one line apart. Nothing validates
`playbackType` or `activePadBehavior` today, so it has never been seen; it
would appear the moment a validator did.

The fix is to pick one owner. `FormField` is the better one — it already owns
the label and the field's spacing — which would mean dropping `error` from the
`RadioGroup` call sites rather than from the component, since a standalone
group still needs somewhere to say it.

Noticed while giving the four groups an accessible name (🟡 3 of the 08-21
review).

## A failed orphan scan tells the user nothing

`OrphanedAudioPanel`'s `handleScanOrphans` catches, writes a
`console.error`, and leaves the panel exactly as it was — the comment in the
branch still reads "You could add error handling here if needed". Press Scan,
watch the spinner come and go, and nothing appears: indistinguishable from a
scan that found nothing, except that the results box is absent rather than
saying "0 orphaned". `handleScanMissing` is the same shape.

Both sit one panel away from `DuplicateAudioPanel`, which does the thing
worth copying — an `error` piece of state, rendered in a `role="alert"` box
naming the message. There is a test for the swallowed branch already
(`leaves no results behind when the scan itself fails`), so the fix is the
state plus the box plus one changed assertion.

## The cleanup report vanishes half a second after it appears

A cleanup that deleted something schedules a re-scan 500 ms later, and
`handleScanOrphans` opens by clearing the cleanup result. So "Files deleted:
2, Cache entries cleared: 1" is on screen for half a second and is then
replaced by a scan saying 0 orphans — the report of what was deleted is the
one thing a user might want to read twice, and it is the thing that goes. The
re-scan itself is right (the counts on screen come from the database rather
than from the panel's arithmetic); it is the clearing that is wrong, and
`handleScanOrphans` clears it because it is also the manual Scan handler.

Noticed while extracting the Maintenance tab into its own panels (finding 8
of the 2026-08-21 review).
