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

## A renamed profile never converges, and the conflict modal lies about it

`src/lib/googleDrive/dataAccess.ts:278` — `updateLocalData` pins the profile
name to the local value:

```ts
name: existingLocalProfile?.name ?? data.profile.name,
```

`existingLocalProfile.name` is always set, so the local name always wins and a
remote rename never lands. Nothing else applies one either — `applySyncedProfile`
does not touch the name, and no other call site writes it from sync data.

The sharp edge is that `detectProfileConflicts` disagrees. It treats `name` as
ordinary content, merges a newer remote name into `mergedData`, and can raise a
**manual conflict** over it — so the resolution modal asks the user to choose
between two names, and then `updateLocalData` discards the choice if they picked
the remote one. Either the name is local-only bookkeeping (in which case it
belongs in `PROFILE_LOCATION_FIELDS` and should never reach the modal) or it is
content (in which case the pin should go). Right now it is both.

Noticed while excluding the _location_ fields from the merge; the name is a
separate question, and changing it alters convergence for every existing synced
profile, so it wanted its own change and its own test.
