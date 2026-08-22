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

## `check_version_sync.sh` only ever looks at one Dockerfile

`scripts/check_version_sync.sh` picks the first of `Dockerfile` / `Containerfile`
and `break`s, so a repo with more than one Dockerfile has all but one unchecked.
That is how `Dockerfile.dev` sat on `node:22-alpine` while `.node-version`,
`mise.toml` and the production Dockerfile were all on 24.19.0, with the gate
green throughout — and CLAUDE.md claiming Node 24 "everywhere".

The local half is fixed: `Dockerfile.dev` now takes the same
`ARG NODE_VERSION=24.19.0`. The gate still cannot see it.

This belongs upstream rather than here — the script's own header says "Part of
the dev-env standard (dev-hooks:dev-env-setup, v23) … Don't hand-edit the
logic; the next policy change should be a plain re-copy of the template", so a
local edit would be reverted by the next template sync. The change wanted is to
iterate every matching Dockerfile rather than break on the first:

```sh
for f in Dockerfile Containerfile Dockerfile.*; do
  [ -f "$f" ] || continue
  # ...check this one too, rather than DOCKERFILE=$f; break
done
```

Noticed while fixing the Node pin during the whole-repo review.

## The `audioFiles` `name` index has no readers left

`db.ts` creates it (`audioStore.createIndex("name", "name")`, DB v1) and
nothing looks anything up in it any more: the Drive reader's name fallback was
the last reader, and it is gone. The only surviving `index("name")` in the
codebase is on `profiles`, where import uses it to make a unique profile name.

It costs an index write per audio row and, more to the point, it is a loaded
gun — the shape of "match a sound by its name" is one lookup away for as long
as the index exists. Removing it needs a schema version bump and a migration,
which is why it was not done alongside the fallback.

Noticed while making the Drive reader identify audio by content hash only.

## Two sound rows in the pad editor can share a `data-testid`

`EditPadForm`'s list rows are tagged `edit-pad-sound-item-${sound.fileId}`,
and so are the trim, gain and remove controls inside them. A pad may name one
audio row twice — legitimately, since a sequential pad can play a sound twice
in a round, and reuse by content hash makes it easy to arrive at. The drag ids
were fixed for that in Task 3 (`placeSounds` numbers the copies); the test ids
were not, because `e2e-tests/loudness.spec.ts:199` parses the audio file id
back out of `edit-pad-gain-sound-${id}` and several specs match on the
`edit-pad-sound-item-` prefix.

Nothing is broken today: no spec builds a pad that names one sound twice. One
that did would hit Playwright's strict-mode "resolved to 2 elements". The fix
is to tag the row with the drag id and keep the file id only where a spec
genuinely needs to read it back.

Noticed while converting the pad editor (Task 3 of the audio-dedup plan).

## `bankUtils.ts` spells the 20-bank cap out three times

`MAX_BANKS` lives in `db.ts:139` and is read by `addBank`, `page.tsx` and
`profileStore.ts`. `convertBankNumberToIndex` and `convertIndexToBankNumber`
in `src/lib/bankUtils.ts` still carry the number as literals — `bankNumber <= 20`
and `index <= 19` — alongside the 9/10 boundary the keyboard's "0-for-10"
quirk needs.

They are correct today and they are genuinely a keyboard mapping rather than a
capacity rule, so this is not urgent. But raising the cap would mean editing
`db.ts` and then finding these, and "the same rule written twice" is this
repo's characteristic regression.

Noticed while checking whether Task 8 of the audio-dedup plan still needed to
add `MAX_BANKS` (it did not — main had already added it, to `db.ts`).

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
