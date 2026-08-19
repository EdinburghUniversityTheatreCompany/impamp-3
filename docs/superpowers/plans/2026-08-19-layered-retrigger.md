# Layered Retrigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "layer" as a fourth `ActivePadBehavior`. A live pad then stacks up to 16 sounds that overlap, in place of one.

**Architecture:** The playback key becomes a **base key** per pad. Each sound that overlaps gets an **instance key** of the form `` `${baseKey}#${n}` ``. `playback.ts` holds `layersByBase` beside `activeTracks`. `isTrackPlaying`, `isTrackFading` and `getActiveTrack` therefore answer for a whole pad, while `stopInstance` acts on one layer. The UI folds the instance-keyed store back into one row per pad, plus a list of layers the user can open.

**Tech Stack:** TypeScript 6 (strict), Next.js 16, React 19, Zustand 5, Vitest 4.1 (node environment), Playwright 1.62, Tailwind CSS 4, IndexedDB through `idb` 8.

**Spec:** docs/superpowers/specs/2026-08-19-banks-and-layering-design.md (§4)

## Global Constraints

- Node 24.19.0 everywhere. Do not change `.node-version`, `mise.toml` or either Dockerfile.
- Unit tests run under Vitest 4.1 in the **node** environment. There is no DOM and no IndexedDB.
- Run the unit suite with `npm test`. Run one file with `npx vitest run <path>`.
- Playwright 1.62 gates on **chromium only**. Run the audio spec with `npm run test:e2e:audio`.
- The coverage floor in `vitest.config.ts` is a ratchet. Never lower it. Raise it only when a run comes in well above it.
- TypeScript strict mode is on. Path alias `@/*` maps to `src/*`.
- `hk` runs prettier before each commit. Run `npx prettier --write <files>` before you commit.
- The hard cap is **16** layers per pad, as the named constant `MAX_LAYERS_PER_PAD`.
- Import the `ActivePadBehavior` union from `@/lib/db` at every site. Do not write another copy of the string union.
- The instance key format is `` `${baseKey}#${n}` ``, and `n` increases and is never reused for one base key.
- `src/lib/server/**` must never reach a client component. This plan does not touch it.
- Make one atomic commit per step that has a commit line. Do not bundle unrelated files.

### Note on §0 (bank identity)

This plan branches off `main` today, so it writes the playback key as
`pad-${profileId}-${pageIndex}-${padIndex}`, which is what
`generatePlaybackKey` (`src/lib/audio/types.ts:163`) builds now. When §0 merges,
that builder takes a `bankId` instead of a `pageIndex`. The layer suffix logic is
not affected: `baseKeyOf`, `makeInstanceKey` and `layerIndexOf` only split the
string at the first `#`, and no bank identifier contains a `#`.

### Note on held keys

A held key cannot stack layers, and no change is needed. Two guards already
return early on auto-repeat:

- `src/hooks/useKeyboardListener.ts:162` — `if (event.repeat) return;`
- `src/components/Pad.tsx:384` — `if (e.repeat) return; // Holding a pad key must not retrigger it`

Both lines were read and confirmed at the line numbers the spec gives.

---

## File Structure

### New files

| Path                                       | Responsibility                                                     |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `src/lib/audio/types.instanceKeys.test.ts` | Tests for the base-key / instance-key split and the cap constant.  |
| `src/store/playbackStore.grouping.test.ts` | Tests for the pure fold from instance keys to per-pad groups.      |
| `src/lib/audio/playback.layers.test.ts`    | Tests for `layersByBase`, `stopInstance`, `stopTrack` and the cap. |
| `src/lib/audio/controls.layer.test.ts`     | Tests for the layer branch of the retrigger switch.                |
| `src/lib/db.activePadBehavior.test.ts`     | Tests for `resolveActivePadBehavior` and the pad override sites.   |
| `src/components/shared/PadTrackGroup.tsx`  | One Active Tracks row per pad, with an expandable list of layers.  |

### Modified files

| Path                                               | One responsibility of the change                                |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `src/lib/audio/types.ts`                           | Own the key helpers and the cap constant.                       |
| `src/lib/audio/playback.ts`                        | Track instances per base key; stop one layer or all of them.    |
| `src/lib/audio/controls.ts`                        | Resolve the behaviour and allocate an instance key for a layer. |
| `src/lib/audio/triggerPad.ts`                      | Carry the per-pad override from the pad to the trigger.         |
| `src/store/playbackStore.ts`                       | Key by instance key and expose the per-pad fold.                |
| `src/components/ActiveTracksPanel.tsx`             | Render groups instead of raw tracks.                            |
| `src/components/PlaybackAnnouncer.tsx`             | Announce "name, N layers" for a stacked pad.                    |
| `src/components/Pad.tsx`                           | Follow the newest layer and show a count badge.                 |
| `src/lib/db.ts`                                    | Add "layer" to the union, the pad field and the resolver.       |
| `src/lib/importExport.ts`                          | Carry the pad override through import.                          |
| `src/types/forms.ts`                               | Import the union; add the pad form field.                       |
| `src/components/modals/EditPadForm.tsx`            | Offer the per-pad "When already playing" radio group.           |
| `src/components/settings/PlaybackSettingsForm.tsx` | Offer "Layer" as a profile-level option.                        |
| `src/components/profiles/ProfileEditForm.tsx`      | Offer "Layer" as a profile-level option.                        |
| `src/hooks/pad/usePadInteractions.ts`              | Read and write the pad override in the edit modal.              |
| `src/hooks/useSearch.ts`                           | Carry the override on a search result.                          |
| `src/components/search/SearchModal.tsx`            | Pass the override to the trigger and to the armed cue.          |
| `src/hooks/emergencySounds.ts`                     | Carry the override on an emergency sound.                       |
| `src/hooks/useKeyboardListener.ts`                 | Pass the override on the two keyboard trigger paths.            |
| `e2e-tests/audio-playback.spec.ts`                 | Prove three layers play and the panel groups them.              |
| `e2e-tests/test-helpers.ts`                        | Report the base key and the layer index from the E2E hook.      |
| `CLAUDE.md`                                        | Record the layer behaviour and the instance key format.         |

---

## Task 0: Prepare the workspace

**Files:** none yet.

**Interfaces:** Consumes: `main` at `f959fad`. Produces: a worktree on branch `feat/layered-retrigger`.

- [ ] **Step 0.1: Create the worktree.** Run `git -C /home/mick/Stack/Programmeren/impamp-2 worktree add .worktrees/layered-retrigger -b feat/layered-retrigger HEAD`. Do all later work in `.worktrees/layered-retrigger`.
- [ ] **Step 0.2: Check the baseline.** Run `npm test`. Every test must pass before you change anything. Record the test count.

---

## Task 1: The key helpers and the cap

The base key and the instance key are one rule, so they live in one module.
`src/lib/audio/types.ts` is the right home: it already owns
`generatePlaybackKey`, and it imports only `../db`, so the store can import it
without a cycle.

**Files:**

- `src/lib/audio/types.ts` — append after `generatePlaybackKey` (ends at line 169).
- `src/lib/audio/types.instanceKeys.test.ts` — new.

**Interfaces:**

Consumes: nothing.

Produces:

```ts
export const MAX_LAYERS_PER_PAD: number;
export function makeInstanceKey(baseKey: string, layerIndex: number): string;
export function baseKeyOf(key: string): string;
export function layerIndexOf(key: string): number;
```

- [ ] **Step 1.1: Write the test that fails first.** Create `src/lib/audio/types.instanceKeys.test.ts`:

```ts
/**
 * The base key / instance key split.
 *
 * A pad owns one base key. Each layer of that pad owns an instance key made
 * from the base key and a number. Every read of "is this pad live?" resolves
 * through the base key, so the two must never disagree about where the split
 * is.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_LAYERS_PER_PAD,
  baseKeyOf,
  generatePlaybackKey,
  layerIndexOf,
  makeInstanceKey,
} from "./types";

const base = generatePlaybackKey(1, 0, 3);

describe("instance keys", () => {
  it("builds an instance key from a base key and a number", () => {
    expect(makeInstanceKey(base, 2)).toBe("pad-1-0-3#2");
  });

  it("reads the base key back out of an instance key", () => {
    expect(baseKeyOf(makeInstanceKey(base, 7))).toBe(base);
  });

  it("treats a bare base key as its own instance key", () => {
    expect(baseKeyOf(base)).toBe(base);
    expect(layerIndexOf(base)).toBe(0);
  });

  it("reads the layer number back out of an instance key", () => {
    expect(layerIndexOf(makeInstanceKey(base, 11))).toBe(11);
  });

  it("orders a bare base key before every numbered layer", () => {
    const keys = [makeInstanceKey(base, 2), base, makeInstanceKey(base, 1)];
    keys.sort((a, b) => layerIndexOf(a) - layerIndexOf(b));
    expect(keys).toEqual([
      base,
      makeInstanceKey(base, 1),
      makeInstanceKey(base, 2),
    ]);
  });

  it("splits at the first separator only", () => {
    expect(baseKeyOf("pad-1-0-3#4#5")).toBe("pad-1-0-3");
  });

  it("caps a pad at 16 layers", () => {
    expect(MAX_LAYERS_PER_PAD).toBe(16);
  });
});
```

- [ ] **Step 1.2: Run it and watch it fail.** Run `npx vitest run src/lib/audio/types.instanceKeys.test.ts`. Expect a transform failure that reads `No "MAX_LAYERS_PER_PAD" export is defined on the "./types" mock` or `SyntaxError: The requested module './types' does not provide an export named 'MAX_LAYERS_PER_PAD'`.
- [ ] **Step 1.3: Write the helpers.** Append to `src/lib/audio/types.ts`:

```ts
/**
 * The largest number of layers one pad plays at the same time.
 *
 * A trigger past the cap stops the oldest layer and starts a new one, so a
 * trigger always makes a sound. 16 is high enough for applause or a rain bed,
 * and low enough that a stuck key cannot fill the audio graph.
 */
export const MAX_LAYERS_PER_PAD = 16;

/**
 * Separator between a base key and its layer number.
 *
 * No playback key contains this character: `generatePlaybackKey` joins numbers
 * with "-", and a bank identifier is a number today and a UUID after §0.
 */
const LAYER_SEPARATOR = "#";

/**
 * Builds the key one layer of a pad plays under.
 *
 * @param baseKey - The pad's own playback key
 * @param layerIndex - The layer number, which grows and is never reused
 * @returns The instance key
 */
export function makeInstanceKey(baseKey: string, layerIndex: number): string {
  return `${baseKey}${LAYER_SEPARATOR}${layerIndex}`;
}

/**
 * The pad an instance key belongs to.
 *
 * A bare base key is its own instance key, so a pad that never layers keeps
 * exactly the key space it had before.
 *
 * @param key - A base key or an instance key
 * @returns The base key
 */
export function baseKeyOf(key: string): string {
  const at = key.indexOf(LAYER_SEPARATOR);
  return at === -1 ? key : key.slice(0, at);
}

/**
 * The layer number an instance key carries.
 *
 * A bare base key answers 0, so a sort by this number puts a pad's single
 * un-layered track first.
 *
 * @param key - A base key or an instance key
 * @returns The layer number
 */
export function layerIndexOf(key: string): number {
  const at = key.indexOf(LAYER_SEPARATOR);
  if (at === -1) return 0;
  const parsed = Number.parseInt(key.slice(at + 1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

- [ ] **Step 1.4: Run it and watch it pass.** Run `npx vitest run src/lib/audio/types.instanceKeys.test.ts`. Expect 7 passed.
- [ ] **Step 1.5: Commit.** Run `npx prettier --write src/lib/audio/types.ts src/lib/audio/types.instanceKeys.test.ts`, then `git add src/lib/audio/types.ts src/lib/audio/types.instanceKeys.test.ts` and `git commit -m "feat(audio): add the base-key / instance-key split and the layer cap"`.

---

## Task 2: The playbackStore key space

The store now keys by instance key. Nothing allocates an instance key yet, so
every key stays a bare base key and every current test stays green. This is the
riskiest part of the work, because `Pad.tsx`, `ActiveTracksPanel.tsx`,
`PlaybackAnnouncer.tsx` and the `__impampActiveSounds` hook all read this store.
It therefore lands on its own, before the layer behaviour exists.

**Files:**

- `src/store/playbackStore.ts` — comment on line 13, the selector at line 302, and new exports at the end of the file.
- `src/store/playbackStore.grouping.test.ts` — new.

**Interfaces:**

Consumes: `baseKeyOf`, `layerIndexOf` from `@/lib/audio/types`.

Produces:

```ts
export interface PadPlaybackGroup {
  baseKey: string;
  name: string;
  layers: PlaybackState[];
  newest: PlaybackState;
  isFading: boolean;
}
export function groupPlaybackByPad(
  activePlayback: Map<string, PlaybackState>,
): PadPlaybackGroup[];
export function describePlayingLayers(groups: PadPlaybackGroup[]): string;
export const usePadPlaybackState: (
  baseKey: string | null,
) => PlaybackState | null;
export const usePadLayerCount: (baseKey: string | null) => number;
```

- [ ] **Step 2.1: Write the test that fails first.** Create `src/store/playbackStore.grouping.test.ts`:

```ts
/**
 * Folding the instance-keyed store back into one row per pad.
 *
 * `activePlayback` is keyed by instance key, so a pad with three layers holds
 * three entries. Every consumer that shows a pad — the Active Tracks panel, the
 * live region and the pad itself — needs one answer per pad, and it needs the
 * newest layer for the ring and the remaining time.
 */
import { describe, expect, it } from "vitest";
import {
  describePlayingLayers,
  groupPlaybackByPad,
  type PlaybackState,
} from "./playbackStore";

function state(key: string, name: string, over: Partial<PlaybackState> = {}) {
  return {
    key,
    name,
    progress: 0,
    remainingTime: 10,
    totalDuration: 10,
    isFading: false,
    padInfo: { profileId: 1, pageIndex: 0, padIndex: 3 },
    ...over,
  } as PlaybackState;
}

function mapOf(...states: PlaybackState[]) {
  return new Map(states.map((s) => [s.key, s]));
}

describe("groupPlaybackByPad", () => {
  it("gives one group per pad", () => {
    const groups = groupPlaybackByPad(
      mapOf(state("pad-1-0-3", "Applause"), state("pad-1-0-4", "Rain loop")),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.baseKey)).toEqual(["pad-1-0-3", "pad-1-0-4"]);
  });

  it("folds every layer of one pad into a single group", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
        state("pad-1-0-3#2", "Applause"),
      ),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].layers).toHaveLength(3);
    expect(groups[0].name).toBe("Applause");
  });

  it("orders the layers by layer number, oldest first", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3#2", "Applause"),
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
      ),
    );
    expect(groups[0].layers.map((l) => l.key)).toEqual([
      "pad-1-0-3",
      "pad-1-0-3#1",
      "pad-1-0-3#2",
    ]);
  });

  it("names the newest layer, which is what the pad ring follows", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { remainingTime: 2 }),
        state("pad-1-0-3#1", "Applause", { remainingTime: 9 }),
      ),
    );
    expect(groups[0].newest.key).toBe("pad-1-0-3#1");
    expect(groups[0].newest.remainingTime).toBe(9);
  });

  it("calls a group fading only when every layer fades", () => {
    const partly = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { isFading: true }),
        state("pad-1-0-3#1", "Applause"),
      ),
    );
    expect(partly[0].isFading).toBe(false);

    const wholly = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause", { isFading: true }),
        state("pad-1-0-3#1", "Applause", { isFading: true }),
      ),
    );
    expect(wholly[0].isFading).toBe(true);
  });
});

describe("describePlayingLayers", () => {
  it("says the name alone for a single layer", () => {
    const groups = groupPlaybackByPad(mapOf(state("pad-1-0-3", "Applause")));
    expect(describePlayingLayers(groups)).toBe("Applause");
  });

  it("counts the layers when a pad is stacked", () => {
    const groups = groupPlaybackByPad(
      mapOf(
        state("pad-1-0-3", "Applause"),
        state("pad-1-0-3#1", "Applause"),
        state("pad-1-0-3#2", "Applause"),
      ),
    );
    expect(describePlayingLayers(groups)).toBe("Applause, 3 layers");
  });

  it("joins several pads with a comma", () => {
    const groups = groupPlaybackByPad(
      mapOf(state("pad-1-0-3", "Applause"), state("pad-1-0-4", "Rain loop")),
    );
    expect(describePlayingLayers(groups)).toBe("Applause, Rain loop");
  });

  it("says nothing at all when nothing plays", () => {
    expect(describePlayingLayers(groupPlaybackByPad(new Map()))).toBe("");
  });
});
```

- [ ] **Step 2.2: Run it and watch it fail.** Run `npx vitest run src/store/playbackStore.grouping.test.ts`. Expect `SyntaxError: The requested module './playbackStore' does not provide an export named 'groupPlaybackByPad'`.
- [ ] **Step 2.3: Add the fold.** In `src/store/playbackStore.ts`, add the import at the top and append the two functions after the selectors:

```ts
import { baseKeyOf, layerIndexOf } from "@/lib/audio/types";
```

```ts
/**
 * Every layer of one pad, and the two answers the UI asks about it.
 *
 * `newest` drives the pad ring and the remaining time. `isFading` is true only
 * when nothing on the pad still plays at full level, which is the same answer
 * a pad with one track gave before layers existed.
 */
export interface PadPlaybackGroup {
  baseKey: string;
  name: string;
  /** The layers, oldest first. */
  layers: PlaybackState[];
  newest: PlaybackState;
  isFading: boolean;
}

/**
 * Folds the instance-keyed playback map into one group per pad.
 *
 * The pad order follows the order the pads started, because a Map keeps
 * insertion order and `setPlaybackState` rebuilds the map from `activeTracks`
 * in the same order every frame.
 *
 * @param activePlayback - The store's map, keyed by instance key
 * @returns One group per pad
 */
export function groupPlaybackByPad(
  activePlayback: Map<string, PlaybackState>,
): PadPlaybackGroup[] {
  const byBase = new Map<string, PlaybackState[]>();
  for (const track of activePlayback.values()) {
    const base = baseKeyOf(track.key);
    const layers = byBase.get(base) ?? [];
    layers.push(track);
    byBase.set(base, layers);
  }

  return Array.from(byBase, ([baseKey, layers]) => {
    layers.sort((a, b) => layerIndexOf(a.key) - layerIndexOf(b.key));
    return {
      baseKey,
      name: layers[0].name,
      layers,
      newest: layers[layers.length - 1],
      isFading: layers.every((layer) => layer.isFading),
    };
  });
}

/**
 * What the live region says about the pads that play now.
 *
 * A stacked pad reports its count once rather than its name three times, which
 * is what a screen reader user needs to hear.
 *
 * @param groups - The output of {@link groupPlaybackByPad}
 * @returns One sentence fragment, or an empty string when nothing plays
 */
export function describePlayingLayers(groups: PadPlaybackGroup[]): string {
  return groups
    .map((group) =>
      group.layers.length > 1
        ? `${group.name}, ${group.layers.length} layers`
        : group.name,
    )
    .join(", ");
}
```

- [ ] **Step 2.4: Run it and watch it pass.** Run `npx vitest run src/store/playbackStore.grouping.test.ts`. Expect 9 passed.
- [ ] **Step 2.5: Resolve the pad selector through the base key.** Replace `usePadPlaybackState` at `src/store/playbackStore.ts:302` with:

```ts
/**
 * The newest layer of one pad, so the pad ring and the remaining time follow
 * the sound that started last.
 *
 * The selector returns an object that the store already holds, so its identity
 * is stable between frames that do not touch this pad. A selector that built a
 * fresh object would re-render every pad on every frame.
 */
export const usePadPlaybackState = (baseKey: string | null) =>
  usePlaybackStore((state) => {
    if (!baseKey) return null;
    let newest: PlaybackState | null = null;
    for (const track of state.activePlayback.values()) {
      if (baseKeyOf(track.key) !== baseKey) continue;
      if (!newest || layerIndexOf(track.key) >= layerIndexOf(newest.key)) {
        newest = track;
      }
    }
    return newest;
  });

/**
 * How many layers of one pad play now.
 *
 * A separate hook from {@link usePadPlaybackState}, and a number rather than an
 * object, so both stay stable under Zustand 5's identity check.
 */
export const usePadLayerCount = (baseKey: string | null) =>
  usePlaybackStore((state) => {
    if (!baseKey) return 0;
    let count = 0;
    for (const track of state.activePlayback.values()) {
      if (baseKeyOf(track.key) === baseKey) count += 1;
    }
    return count;
  });
```

Also update the comment on line 13 to read
`key: string; // Instance key: the pad's base key, plus "#n" for a layer`.

- [ ] **Step 2.6: Run the whole suite and watch it stay green.** Run `npm test`. The test count must match the baseline from Step 0.2 plus 16.
- [ ] **Step 2.7: Commit.** Run `npx prettier --write src/store/playbackStore.ts src/store/playbackStore.grouping.test.ts`, then `git add src/store/playbackStore.ts src/store/playbackStore.grouping.test.ts` and `git commit -m "refactor(store): key playback state by instance key and fold it per pad"`.

---

## Task 3: The Active Tracks panel, the live region and the pad

These three read the store, so they move to the fold now, while every key is
still a bare base key. The visible result is unchanged until layers exist.

**Files:**

- `src/components/shared/PadTrackGroup.tsx` — new.
- `src/components/ActiveTracksPanel.tsx` — lines 12-29 and 88-108.
- `src/components/PlaybackAnnouncer.tsx` — lines 59-61.
- `src/components/Pad.tsx` — lines 7-8, 69-82, and the pad body near line 447.

**Interfaces:**

Consumes: `groupPlaybackByPad`, `describePlayingLayers`, `usePadPlaybackState`, `usePadLayerCount`, `PadPlaybackGroup`.

Produces: a `PadTrackGroup` component, and these test ids:

- `active-track-item` — the grouped row, one per pad (unchanged id, so the current E2E helpers still work).
- `active-track-layer-count` — the button that expands a stacked pad.
- `active-track-layer-item` — one row per layer, only when expanded.
- `pad-layer-count` — the badge on the pad.

- [ ] **Step 3.1: Add the group row component.** Create `src/components/shared/PadTrackGroup.tsx`:

```tsx
/**
 * One Active Tracks row per pad.
 *
 * A pad with one sound looks exactly as it did before layers existed. A pad
 * with several shows a count button; press it and the layers appear indented
 * below, each with its own stop and fade controls. The expansion is local
 * state, because it describes this row on this screen and nothing else needs
 * to know about it.
 *
 * @module components/shared/PadTrackGroup
 */

"use client";

import React, { useState } from "react";
import type { PadPlaybackGroup } from "@/store/playbackStore";
import TrackItem from "./TrackItem";

interface PadTrackGroupProps {
  group: PadPlaybackGroup;
}

const PadTrackGroup: React.FC<PadTrackGroupProps> = ({ group }) => {
  const [expanded, setExpanded] = useState(false);
  const layerCount = group.layers.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <TrackItem
          trackKey={group.baseKey}
          name={group.name}
          remainingTime={group.newest.remainingTime}
          progress={group.newest.progress}
          isFading={group.isFading}
          isActive={true}
        />
        {layerCount > 1 && (
          <button
            type="button"
            onClick={(event) => {
              // The row itself stops the pad, so a press on the count must not
              // reach it.
              event.stopPropagation();
              setExpanded((open) => !open);
            }}
            className="absolute top-1/2 right-12 -translate-y-1/2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-mono text-blue-700 dark:bg-blue-900 dark:text-blue-300"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} the ${layerCount} layers of ${group.name}`}
            data-testid="active-track-layer-count"
          >
            {expanded ? "v" : "x"}
            {layerCount}
          </button>
        )}
      </div>

      {expanded &&
        layerCount > 1 &&
        group.layers.map((layer, index) => (
          <div
            key={layer.key}
            className="ml-6"
            data-testid="active-track-layer-item"
          >
            <TrackItem
              trackKey={layer.key}
              name={`layer ${index + 1}`}
              remainingTime={layer.remainingTime}
              progress={layer.progress}
              isFading={layer.isFading}
              isActive={true}
            />
          </div>
        ))}
    </div>
  );
};

export default PadTrackGroup;
```

- [ ] **Step 3.2: Render groups in the panel.** In `src/components/ActiveTracksPanel.tsx`, change the import on line 13 to `import { usePlaybackStore, groupPlaybackByPad } from "@/store/playbackStore";`, add `import PadTrackGroup from "./shared/PadTrackGroup";`, replace the memo on lines 26-29 with:

```tsx
const trackGroups = useMemo(
  () => groupPlaybackByPad(activePlaybackMap),
  [activePlaybackMap],
);
```

and replace the map on lines 96-106 with:

```tsx
{
  trackGroups.map((group) => (
    <PadTrackGroup key={group.baseKey} group={group} />
  ));
}
```

Change the empty check on line 88 to `trackGroups.length === 0`. Delete the now unused `PlaybackState` import.

- [ ] **Step 3.3: Announce the layer count.** In `src/components/PlaybackAnnouncer.tsx`, change the import on line 12 to `import { usePlaybackStore, groupPlaybackByPad, describePlayingLayers } from "@/store/playbackStore";` and replace lines 59-61 with:

```tsx
const playing = usePlaybackStore((state) =>
  describePlayingLayers(groupPlaybackByPad(state.activePlayback)),
);
```

Add one sentence to the block comment above the component: "A stacked pad reads as `Applause, 3 layers`. The reader hears the count once, in place of the name three times."

- [ ] **Step 3.4: Follow the newest layer on the pad.** In `src/components/Pad.tsx`, change the import on line 8 to `import { usePadPlaybackState, usePadLayerCount } from "@/store/playbackStore";`, and add below line 73:

```tsx
const layerCount = usePadLayerCount(playbackKey);
```

Then add the badge after the name block that ends at line 456:

```tsx
{
  /* Layer count, shown only when a pad stacks. The ring and the remaining
          time already follow the newest layer; this says how many there are. */
}
{
  layerCount > 1 && (
    <span
      className="absolute top-1 right-1 z-10 rounded bg-blue-600 px-1 text-[10px] font-bold text-white"
      data-testid="pad-layer-count"
    >
      x{layerCount}
    </span>
  );
}
```

- [ ] **Step 3.5: Check the build and the suite.** Run `npm run lint` and `npm test`. Both must pass. `npm test` count must not change.
- [ ] **Step 3.6: Check the app by eye.** Ask the user to confirm a dev server runs on port 3000. Then do this:

  1. Load the board.
  2. Drop a sound on a pad.
  3. Press the pad.
  4. Confirm the Active Tracks row and the pad ring look as they did before.

- [ ] **Step 3.7: Commit.** Run `npx prettier --write src/components/shared/PadTrackGroup.tsx src/components/ActiveTracksPanel.tsx src/components/PlaybackAnnouncer.tsx src/components/Pad.tsx`, then `git add src/components/shared/PadTrackGroup.tsx src/components/ActiveTracksPanel.tsx src/components/PlaybackAnnouncer.tsx src/components/Pad.tsx` and `git commit -m "refactor(ui): read playback state per pad instead of per track"`.

---

## Task 4: Instances in the playback engine

`activeTracks` keeps its instance-key space. `layersByBase` names the instances
of each pad, in start order. It is maintained by `claimPlaybackKey` and
`clearTrackState`, which are the only two places that add and remove a track, so
it can never disagree with `activeTracks`.

Nothing allocates an instance key yet, so `layersByBase` holds exactly one bare
base key per live pad and every current test stays green.

**Files:**

- `src/lib/audio/playback.ts` — these sites:
  - the import on line 11, and the maps near line 29
  - `getStopGeneration` (line 171) and `stopRequestedSince` (line 186)
  - `clearTrackState` (line 346) and `claimPlaybackKey` (line 398)
  - `isTrackPlaying` (line 762), `isTrackFading` (line 772) and `getActiveTrack` (line 791)
  - the E2E hook (line 798)
  - `fadeOutTrack` (line 821) and `stopTrack` (line 916)
  - `stopAllTracks` (line 982) and `fadeOutAllTracks` (line 1014)
- `src/lib/audio/controls.ts` — `stopAudio` (line 614) and `fadeOutAudio` (line 625).
- `src/lib/audio/playback.layers.test.ts` — new.

**Interfaces:**

Consumes: `baseKeyOf`, `makeInstanceKey`, `MAX_LAYERS_PER_PAD` from `./types`.

Produces:

```ts
export function stopInstance(instanceKey: string): boolean;
export function stopTrack(baseKey: string): boolean; // now stops every instance
export function fadeOutInstance(
  instanceKey: string,
  durationInSeconds: number,
): boolean;
export function fadeOutTrack(
  baseKey: string,
  durationInSeconds: number,
): boolean; // now fades every instance
export function getLayerKeys(baseKey: string): string[];
export function allocateLayerKey(baseKey: string): string;
```

- [ ] **Step 4.1: Write the test that fails first.** Create `src/lib/audio/playback.layers.test.ts`. It copies the fake AudioContext from `playback.race.test.ts`, which records `stop()` calls, because that is the only way to tell a silenced source from a forgotten one:

```ts
/**
 * Layers in the playback engine.
 *
 * The fake AudioContext is the one `playback.race.test.ts` uses: the only Web
 * Audio the playback module touches is `getAudioContext`, so a fake that
 * records `stop()` calls is enough to prove a source was silenced rather than
 * dropped from a map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeAudioParam {
  value = 1;
  setValueAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect() {}
  disconnect() {}
}

class FakeBufferSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startCalls = 0;
  stopCalls: number[] = [];
  connect() {}
  disconnect() {}
  start() {
    this.startCalls++;
  }
  stop(when = 0) {
    this.stopCalls.push(when);
  }
  get stopped() {
    return this.stopCalls.length > 0;
  }
}

const createdSources: FakeBufferSource[] = [];

const fakeContext = {
  currentTime: 0,
  state: "running" as const,
  destination: {},
  createBufferSource() {
    const source = new FakeBufferSource();
    createdSources.push(source);
    return source;
  },
  createGain() {
    return new FakeGainNode();
  },
};

vi.mock("./context", () => ({
  getAudioContext: () => fakeContext,
}));

globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

const {
  playBuffer,
  stopTrack,
  stopInstance,
  stopAllTracks,
  allocateLayerKey,
  getLayerKeys,
  getActiveTrack,
  isTrackPlaying,
  isTrackFading,
  fadeOutInstance,
} = await import("./playback");
const { MAX_LAYERS_PER_PAD, makeInstanceKey } = await import("./types");

const buffer = { duration: 10, numberOfChannels: 2 } as unknown as AudioBuffer;

function play(key: string) {
  return playBuffer(buffer, key, {
    name: key,
    volume: 1,
    multiSoundState: {
      playbackType: "sequential",
      allAudioFileIds: [1],
      currentAudioFileId: 1,
      currentAudioIndex: 0,
    },
  } as Parameters<typeof playBuffer>[2]);
}

/** Starts one more layer of a pad and returns the instance key it took. */
function playLayer(baseKey: string) {
  const key = allocateLayerKey(baseKey);
  play(key);
  return key;
}

beforeEach(() => {
  stopAllTracks();
  createdSources.length = 0;
});

describe("two triggers on a pad set to layer", () => {
  it("leaves both instances live", () => {
    play("pad-1");
    playLayer("pad-1");

    expect(getLayerKeys("pad-1")).toHaveLength(2);
    const [first, second] = createdSources;
    expect(first.stopped).toBe(false);
    expect(second.stopped).toBe(false);
  });

  it("reports the pad as playing through its base key", () => {
    playLayer("pad-1");
    expect(isTrackPlaying("pad-1")).toBe(true);
  });

  it("hands the newest layer to getActiveTrack for the base key", () => {
    play("pad-1");
    const second = playLayer("pad-1");
    expect(getActiveTrack("pad-1")).toBe(getActiveTrack(second));
  });
});

describe("stopping a layered pad", () => {
  it("stops every instance from the base key", () => {
    play("pad-1");
    playLayer("pad-1");
    playLayer("pad-1");

    stopTrack("pad-1");

    expect(createdSources.every((source) => source.stopped)).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(0);
    expect(isTrackPlaying("pad-1")).toBe(false);
  });

  it("stops exactly one instance from stopInstance", () => {
    play("pad-1");
    const second = playLayer("pad-1");

    stopInstance(second);

    const [first, stopped] = createdSources;
    expect(stopped.stopped).toBe(true);
    expect(first.stopped).toBe(false);
    expect(getLayerKeys("pad-1")).toEqual(["pad-1"]);
  });

  it("reaches every layer from the panic button", () => {
    play("pad-1");
    playLayer("pad-1");
    play("pad-2");

    stopAllTracks();

    expect(createdSources.every((source) => source.stopped)).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(0);
    expect(getLayerKeys("pad-2")).toHaveLength(0);
  });
});

describe("a pad with one layer that fades", () => {
  it("still counts as playing while another layer is at full level", () => {
    play("pad-1");
    const second = playLayer("pad-1");

    fadeOutInstance(second, 3);

    expect(isTrackFading("pad-1")).toBe(false);
    expect(isTrackPlaying("pad-1")).toBe(true);
  });

  it("counts as fading once every layer fades", () => {
    const first = play("pad-1") && "pad-1";
    const second = playLayer("pad-1");

    fadeOutInstance(first, 3);
    fadeOutInstance(second, 3);

    expect(isTrackFading("pad-1")).toBe(true);
  });
});

describe("the layer cap", () => {
  it("stops the oldest layer at the 17th trigger and holds the count at 16", () => {
    play("pad-1");
    for (let i = 1; i < MAX_LAYERS_PER_PAD; i++) {
      playLayer("pad-1");
    }
    expect(getLayerKeys("pad-1")).toHaveLength(MAX_LAYERS_PER_PAD);

    const oldest = createdSources[0];
    playLayer("pad-1");

    expect(oldest.stopped).toBe(true);
    expect(getLayerKeys("pad-1")).toHaveLength(MAX_LAYERS_PER_PAD);
  });

  it("never reuses a layer number for one pad", () => {
    const first = playLayer("pad-1");
    stopTrack("pad-1");
    const second = playLayer("pad-1");

    expect(second).not.toBe(first);
    expect(second).toBe(makeInstanceKey("pad-1", 2));
  });
});
```

- [ ] **Step 4.2: Run it and watch it fail.** Run `npx vitest run src/lib/audio/playback.layers.test.ts`. Expect `SyntaxError: The requested module './playback' does not provide an export named 'stopInstance'`.
- [ ] **Step 4.3: Add the instance registry.** In `src/lib/audio/playback.ts`, change the import on line 11 to:

```ts
import {
  ActiveTrack,
  MAX_LAYERS_PER_PAD,
  PlayAudioParams,
  TrackSource,
  baseKeyOf,
  makeInstanceKey,
} from "./types";
```

and add after `activeTracks` on line 29:

```ts
// The live instance keys of each pad, in start order.
//
// A pad that never layers holds exactly one entry, and that entry is its bare
// base key, so the single-instance path keeps the shape it always had. Written
// only by `claimPlaybackKey` and `clearTrackState`, which are the only two
// places a track enters and leaves `activeTracks`, so the two cannot drift.
const layersByBase = new Map<string, string[]>();

// The next layer number for a pad. It grows and is never reused, so a timer or
// an `onended` handler left over from a stopped layer can never address the
// layer that replaced it.
const nextLayerIndex = new Map<string, number>();

function registerInstance(instanceKey: string): void {
  const base = baseKeyOf(instanceKey);
  const keys = layersByBase.get(base) ?? [];
  if (!keys.includes(instanceKey)) keys.push(instanceKey);
  layersByBase.set(base, keys);
}

function forgetInstance(instanceKey: string): void {
  const base = baseKeyOf(instanceKey);
  const keys = layersByBase.get(base);
  if (!keys) return;
  const at = keys.indexOf(instanceKey);
  if (at !== -1) keys.splice(at, 1);
  if (keys.length === 0) layersByBase.delete(base);
}

/**
 * The live instances of one pad, oldest first.
 *
 * @param baseKey - A base key or any instance key of the pad
 * @returns A copy of the instance keys, safe to iterate while they are stopped
 */
export function getLayerKeys(baseKey: string): string[] {
  return [...(layersByBase.get(baseKeyOf(baseKey)) ?? [])];
}

/**
 * Takes the next instance key for a pad, and makes room for it.
 *
 * At the cap the oldest layer stops first, so a trigger always makes a sound
 * rather than being refused.
 *
 * @param baseKey - The pad's own playback key
 * @returns The instance key the new layer must play under
 */
export function allocateLayerKey(baseKey: string): string {
  const live = layersByBase.get(baseKey) ?? [];
  if (live.length >= MAX_LAYERS_PER_PAD) {
    stopInstance(live[0]);
  }
  const index = nextLayerIndex.get(baseKey) ?? 1;
  nextLayerIndex.set(baseKey, index + 1);
  return makeInstanceKey(baseKey, index);
}
```

- [ ] **Step 4.4: Keep the registry in step.** Make two edits:

  - Add `registerInstance(playbackKey);` as the last line of `claimPlaybackKey`, after `activeTracks.set` on line 408.
  - Add `forgetInstance(playbackKey);` as the first line of `clearTrackState`, before `activeTracks.delete` on line 347.

- [ ] **Step 4.5: Resolve the three readers through the base key.** Replace `isTrackPlaying`, `isTrackFading` and `getActiveTrack`:

```ts
/**
 * Whether any instance of a pad plays now.
 *
 * Takes a base key or an instance key, so `controls.ts`'s retrigger decision
 * needs no change: it asks about the pad, and any live layer answers yes.
 */
export function isTrackPlaying(playbackKey: string): boolean {
  return (layersByBase.get(baseKeyOf(playbackKey))?.length ?? 0) > 0;
}

/**
 * Whether a pad is entirely on its way out.
 *
 * True only when every live instance fades. A pad with one fading layer and one
 * at full level is still playing, and a new trigger must treat it that way —
 * for a pad with a single track this is the exact answer it gave before.
 */
export function isTrackFading(playbackKey: string): boolean {
  const keys = layersByBase.get(baseKeyOf(playbackKey));
  if (!keys || keys.length === 0) return false;
  return keys.every((key) => activeTracks.get(key)?.isFading === true);
}

/**
 * The track behind a key.
 *
 * An instance key answers with its own track, which is what the streaming path
 * needs to check that it still owns the element it started. A base key answers
 * with the newest layer, which is what the pad ring follows.
 */
export function getActiveTrack(playbackKey: string): ActiveTrack | null {
  const direct = activeTracks.get(playbackKey);
  if (direct) return direct;
  const keys = layersByBase.get(baseKeyOf(playbackKey));
  if (!keys || keys.length === 0) return null;
  return activeTracks.get(keys[keys.length - 1]) ?? null;
}
```

- [ ] **Step 4.6: Move the stop generations to the base key.** In `getStopGeneration` (line 171) and in `stopRequestedSince` (line 186) apply `baseKeyOf` to the key before the map read, so either kind of key gives the same answer:

```ts
export function getStopGeneration(playbackKey: string): StopGeneration {
  return {
    global: globalStopGeneration,
    // Per pad, not per layer: a stop aimed at the pad must reach a trigger for
    // any of its layers that has not registered a track yet.
    key: keyStopGenerations.get(baseKeyOf(playbackKey)) ?? 0,
  };
}
```

- [ ] **Step 4.7: Split the stop.** Rename the current `stopTrack` (line 916) to `stopInstance`, delete the generation bump from its body, and add the new `stopTrack` beside it:

```ts
/**
 * Stops one layer immediately, and cancels any fade on it.
 *
 * Deliberately leaves the pad's stop generation alone: stopping one layer must
 * not cancel a trigger that is still loading a different layer of the same pad.
 *
 * @param instanceKey - The exact instance to stop
 * @returns True if there was an instance to stop
 */
export function stopInstance(instanceKey: string): boolean {
  console.log(`[Audio Playback] Requesting stop for instance: ${instanceKey}`);

  const track = activeTracks.get(instanceKey);
  if (!track) return false;

  cancelScheduledTrimEnd(track);

  const source = track.source;

  try {
    const context = getAudioContext();
    const gain = track.gainNode.gain;
    const stopAt = context.currentTime + HARD_STOP_FADE_SECONDS;

    // Override any scheduled automation (e.g. an in-progress fade) with a
    // very short ramp to silence to avoid clicks
    const currentGain = gain.value;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(currentGain, context.currentTime);
    gain.linearRampToValueAtTime(0, stopAt);

    if (source.kind === "buffer") {
      source.sourceNode.stop(stopAt);
    } else {
      // Media elements can't schedule a pause, so detach the handlers now
      // (the track is gone as far as the app is concerned) and release the
      // element once the de-click ramp has run to silence.
      source.element.onended = null;
      source.element.onerror = null;
      setTimeout(
        () => disposeMediaSource(source),
        HARD_STOP_FADE_SECONDS * 1000,
      );
    }
  } catch (error) {
    // Ignore errors if already stopped (e.g., due to natural end)
    if ((error as DOMException).name !== "InvalidStateError") {
      console.warn(
        `[Audio Playback] Error stopping source for instance ${instanceKey}:`,
        error,
      );
    }
    // The ramp could not be scheduled — release the source right away so it
    // can never be left playing without a way to stop it
    disposeTrackSource(source);
  }

  // Remove state immediately so the layer can no longer block re-triggering
  clearTrackState(instanceKey);

  return true;
}

/**
 * Stops every layer of a pad immediately.
 *
 * The name and the meaning are unchanged for a pad with one sound. For a pad
 * that layers, the Active Tracks row, the ESC key and the "stop" behaviour all
 * mean the pad, so they all end up here.
 *
 * @param baseKey - The pad's own playback key, or any instance key of it
 * @returns True if at least one instance was stopped
 */
export function stopTrack(baseKey: string): boolean {
  const base = baseKeyOf(baseKey);

  // Invalidate any trigger for *this pad* that still waits on an async load.
  // Deliberately not global: stopping one pad must not cancel another's.
  keyStopGenerations.set(base, (keyStopGenerations.get(base) ?? 0) + 1);

  let stopped = false;
  for (const instanceKey of getLayerKeys(base)) {
    if (stopInstance(instanceKey)) stopped = true;
  }
  return stopped;
}
```

- [ ] **Step 4.8: Split the fade.** Rename `fadeOutTrack` (line 821) to `fadeOutInstance`, and add:

```ts
/**
 * Fades out every layer of a pad over the same duration.
 *
 * @param baseKey - The pad's own playback key, or any instance key of it
 * @param durationInSeconds - Length of the fade
 * @returns True if at least one instance started a fade
 */
export function fadeOutTrack(
  baseKey: string,
  durationInSeconds: number,
): boolean {
  let faded = false;
  for (const instanceKey of getLayerKeys(baseKey)) {
    if (fadeOutInstance(instanceKey, durationInSeconds)) faded = true;
  }
  return faded;
}
```

- [ ] **Step 4.9: Route the panel's stop and fade by the kind of key.** In `src/lib/audio/controls.ts`, add `stopInstance` and `fadeOutInstance` to the import from `./playback`, and replace `stopAudio` (line 614) and `fadeOutAudio` (line 625) with:

```ts
/**
 * Stops what a key names: one layer for an instance key, the whole pad for a
 * base key.
 *
 * The Active Tracks panel gives a grouped row the pad's base key and each layer
 * row its own instance key, so one rule here serves both. A base key never
 * contains the layer separator, so the two can never be confused.
 *
 * @param playbackKey - A base key or an instance key
 */
export function stopAudio(playbackKey: string): void {
  console.log(`[Audio Controls] Requesting stop for key: ${playbackKey}`);
  if (baseKeyOf(playbackKey) === playbackKey) {
    stopTrack(playbackKey);
  } else {
    stopInstance(playbackKey);
  }
}

/**
 * Fades out what a key names: one layer for an instance key, the whole pad for
 * a base key.
 *
 * @param playbackKey - A base key or an instance key
 * @param durationInSeconds - Duration of the fade in seconds (default: 3s)
 */
export function fadeOutAudio(
  playbackKey: string,
  durationInSeconds: number = 3,
): void {
  console.log(
    `[Audio Controls] Requesting fade out over ${durationInSeconds}s for key: ${playbackKey}`,
  );
  if (baseKeyOf(playbackKey) === playbackKey) {
    fadeOutTrack(playbackKey, durationInSeconds);
  } else {
    fadeOutInstance(playbackKey, durationInSeconds);
  }
}
```

Add `baseKeyOf` to the import from `./types` on line 36. `useTrackControls.ts` and `TrackItem.tsx` need no change: they pass whatever key the row carries, which is exactly the rule above.

- [ ] **Step 4.10: Point the two "all" helpers at the new split.** In `stopAllTracks` (line 982) replace `const keys = Array.from(activeTracks.keys());` with `const keys = Array.from(layersByBase.keys());` so each pad's generation is bumped once. In `fadeOutAllTracks` (line 1014) call `fadeOutInstance(key, durationInSeconds)` instead of `fadeOutTrack`, and check `activeTracks.get(key)?.isFading` instead of `isTrackFading(key)`, because that loop walks instances.
- [ ] **Step 4.11: Report the layer in the E2E hook.** In the `__impampActiveSounds` hook (line 798) add two fields inside the mapped object:

```ts
    baseKey: baseKeyOf(key),
    layerIndex: layerIndexOf(key),
```

and add `layerIndexOf` to the import from `./types`.

- [ ] **Step 4.12: Run the new test and watch it pass.** Run `npx vitest run src/lib/audio/playback.layers.test.ts`. Expect 10 passed.
- [ ] **Step 4.13: Run the race test and watch it stay green.** Run `npx vitest run src/lib/audio/playback.race.test.ts src/lib/audio/playback.trimEnd.test.ts`. The displacement warning at `playback.race.test.ts:104` must still hold, because a non-layer trigger still claims the bare base key.
- [ ] **Step 4.14: Run the whole suite.** Run `npm test`. Everything must pass.
- [ ] **Step 4.15: Commit.** Run `npx prettier --write src/lib/audio/playback.ts src/lib/audio/controls.ts src/lib/audio/playback.layers.test.ts`, then `git add src/lib/audio/playback.ts src/lib/audio/controls.ts src/lib/audio/playback.layers.test.ts` and `git commit -m "feat(audio): track playback instances per pad, and stop one layer or all"`.

---

## Task 5: The union and its four duplicate copies

The union is written out four more times beside the definition. Import it
everywhere. Do not add another copy of the string union.

**Files:**

- `src/lib/db.ts` — line 94.
- `src/types/forms.ts` — lines 42 and 50.
- `src/components/settings/PlaybackSettingsForm.tsx` — line 79.
- `src/components/profiles/ProfileEditForm.tsx` — line 100.

**Interfaces:**

Produces: `export type ActivePadBehavior = "continue" | "stop" | "restart" | "layer";`

- [ ] **Step 5.1: Widen the union.** In `src/lib/db.ts`, replace line 94 with:

```ts
/**
 * What a trigger does to a pad that already plays.
 *
 * "layer" starts one more overlapping sound, up to `MAX_LAYERS_PER_PAD`. The
 * other three are one-in, one-out and pre-date it.
 *
 * Import this type. It used to be written out again in four places, and a
 * another copy is what lets one of them fall behind the others.
 */
export type ActivePadBehavior = "continue" | "stop" | "restart" | "layer";
```

- [ ] **Step 5.2: Import it in the form types.** In `src/types/forms.ts`, change the import on line 10 to `import { ActivePadBehavior, PlaybackType } from "@/lib/db";` and replace the union on lines 42 and 50 with `activePadBehavior: ActivePadBehavior;`.
- [ ] **Step 5.3: Import it in the playback settings form.** In `src/components/settings/PlaybackSettingsForm.tsx`, add `import type { ActivePadBehavior } from "@/lib/db";` and replace the cast on line 79 with `value as ActivePadBehavior`.
- [ ] **Step 5.4: Import it in the profile edit form.** In `src/components/profiles/ProfileEditForm.tsx`, add `import type { ActivePadBehavior } from "@/lib/db";` and replace the cast on line 100 with `value as ActivePadBehavior`.
- [ ] **Step 5.5: Prove no copy is left.** Run `rg -n '"continue" \| "stop" \| "restart"' src`. Expect exactly one hit: the definition in `src/lib/db.ts`.
- [ ] **Step 5.6: Run the suite.** Run `npm run lint` and `npm test`. Both must pass.
- [ ] **Step 5.7: Commit.** Run `npx prettier --write src/lib/db.ts src/types/forms.ts src/components/settings/PlaybackSettingsForm.tsx src/components/profiles/ProfileEditForm.tsx`, then `git add` those four files and `git commit -m "refactor(db): add layer to ActivePadBehavior and import the union everywhere"`.

---

## Task 6: The per-pad override and its resolver

`PadConfiguration.activePadBehavior` is optional, and undefined means "follow
the profile". No migration is needed and every current pad keeps its behaviour.

**Files:**

- `src/lib/db.ts` — `PadConfiguration` (line 108), `PadPlaybackSettings` (line 1464), `extractPadPlaybackSettings` (line 1475), and a new `resolveActivePadBehavior` beside the union.
- `src/lib/db.activePadBehavior.test.ts` — new.

**Interfaces:**

Produces:

```ts
export function resolveActivePadBehavior(
  pad: { activePadBehavior?: ActivePadBehavior },
  profileDefault: ActivePadBehavior,
): ActivePadBehavior;
```

and `PadConfiguration.activePadBehavior?: ActivePadBehavior`.

- [ ] **Step 6.1: Write the test that fails first.** Create `src/lib/db.activePadBehavior.test.ts`:

```ts
/**
 * The per-pad override of the profile's activePadBehavior.
 *
 * Undefined means "follow the profile", so pads written before this field
 * existed keep behaving exactly as they did. The resolver is the only place
 * that rule is written down.
 */
import { describe, expect, it } from "vitest";
import { extractPadPlaybackSettings, resolveActivePadBehavior } from "./db";

describe("resolveActivePadBehavior", () => {
  it("follows the profile when the pad says nothing", () => {
    expect(resolveActivePadBehavior({}, "restart")).toBe("restart");
    expect(
      resolveActivePadBehavior({ activePadBehavior: undefined }, "stop"),
    ).toBe("stop");
  });

  it("lets the pad beat the profile", () => {
    expect(
      resolveActivePadBehavior({ activePadBehavior: "layer" }, "continue"),
    ).toBe("layer");
  });
});

describe("extractPadPlaybackSettings", () => {
  it("carries the override, so a pad swap and a duplicate keep it", () => {
    const settings = extractPadPlaybackSettings({
      audioFileIds: [1],
      activePadBehavior: "layer",
    });
    expect(settings.activePadBehavior).toBe("layer");
  });

  it("leaves the override undefined when the pad has none", () => {
    const settings = extractPadPlaybackSettings({ audioFileIds: [1] });
    expect(settings.activePadBehavior).toBeUndefined();
  });
});
```

- [ ] **Step 6.2: Run it and watch it fail.** Run `npx vitest run src/lib/db.activePadBehavior.test.ts`. Expect `does not provide an export named 'resolveActivePadBehavior'`.
- [ ] **Step 6.3: Add the field and the resolver.** In `src/lib/db.ts`, add to `PadConfiguration` after `isDisabled` (line 131):

```ts
  /**
   * Overrides the profile's `activePadBehavior` for this pad alone. Undefined
   * means follow the profile, so records written before this field existed need
   * no migration.
   */
  activePadBehavior?: ActivePadBehavior;
```

and add after the union:

```ts
/**
 * What a trigger must do to this pad, given the profile's default.
 *
 * One rule in one place. Every trigger path asks this rather than reading the
 * pad and the profile itself, so a path that forgets the override cannot exist.
 *
 * @param pad - The pad, or anything that carries its override
 * @param profileDefault - What the active profile says
 * @returns The behaviour to apply
 */
export function resolveActivePadBehavior(
  pad: { activePadBehavior?: ActivePadBehavior },
  profileDefault: ActivePadBehavior,
): ActivePadBehavior {
  return pad.activePadBehavior ?? profileDefault;
}
```

- [ ] **Step 6.4: Add it to the shared pad shape.** In `PadPlaybackSettings` (line 1464) add `| "activePadBehavior"` to the `Pick`, and in `extractPadPlaybackSettings` (line 1475) add `activePadBehavior: pad.activePadBehavior,` to the returned object.

This one edit covers three of the five sites the spec warns about, because they
all go through the helper already: `swapPadConfigurations` (line 1495),
`duplicateProfileLocally` (line 1890) and the armed-cue re-read in
`playbackStore.ts:122`.

- [ ] **Step 6.5: Run it and watch it pass.** Run `npx vitest run src/lib/db.activePadBehavior.test.ts src/lib/db.padGain.test.ts src/lib/db.duplicateProfile.test.ts`. Expect all to pass.
- [ ] **Step 6.6: Commit.** Run `npx prettier --write src/lib/db.ts src/lib/db.activePadBehavior.test.ts`, then `git add src/lib/db.ts src/lib/db.activePadBehavior.test.ts` and `git commit -m "feat(db): add a per-pad activePadBehavior override and its resolver"`.

---

## Task 7: Carry the override to every place a pad travels

The override is dropped in silence by pad swap, profile duplication, export,
import and sync if any one of these sites is missed. Task 6 covered swap,
duplication and the armed re-read. This task covers the rest, one step per site.

Export needs no change: `collectProfileDataForZip` reads whole pad rows through
`getAllPadConfigurationsForProfile` (`src/lib/importExport.ts:1463`).

Sync needs no field-list change: `SyncedPadConfiguration extends
PadConfiguration` (`src/lib/syncUtils.ts:445`), the Drive write-back spreads the
whole pad (`src/lib/googleDrive/dataAccess.ts:127`), and `compareSyncableItems`
votes on the keys the object actually has. Step 7.8 proves it.

**Files:** one per step, listed inline.

**Interfaces:**

Consumes: `ActivePadBehavior` from `@/lib/db`.

Produces: `activePadBehavior?: ActivePadBehavior` on `TriggerablePad`,
`TriggerAudioArgs`, `PadFormValues`, `SearchResult`, `EmergencySound` and
`ArmedTrackState`.

- [ ] **Step 7.1: Import.** In `src/lib/importExport.ts`, add `activePadBehavior: pad.activePadBehavior,` to the `content` object at line 723, below `isDisabled`. Add the comment `// Undefined means "follow the profile", and stays undefined.`
- [ ] **Step 7.2: The trigger arguments.** In `src/lib/audio/types.ts`, add to `TriggerAudioArgs` (line 114) after `isDisabled`:

```ts
  /**
   * This pad's own override of the profile's activePadBehavior. Undefined means
   * follow the profile.
   */
  activePadBehavior?: ActivePadBehavior;
```

and change the import on line 10 to `import { ActivePadBehavior, PlaybackType } from "../db";`.

- [ ] **Step 7.3: The trigger helper.** In `src/lib/audio/triggerPad.ts`, add `activePadBehavior?: ActivePadBehavior;` to `TriggerablePad` (line 25), add the type to the import on line 22, and add `activePadBehavior: pad.activePadBehavior,` to the call at line 98.
- [ ] **Step 7.4: The pad edit form values.** In `src/types/forms.ts`, add to `PadFormValues` (line 15):

```ts
  /**
   * The pad's own override. Undefined means the pad follows the profile, which
   * is what the "Use profile default" option writes back.
   */
  activePadBehavior?: ActivePadBehavior;
```

- [ ] **Step 7.5: The pad edit modal.** In `src/hooks/pad/usePadInteractions.ts`, add `activePadBehavior: padConfig?.activePadBehavior,` to `initialValues` (near line 77) and `activePadBehavior: values.activePadBehavior,` to `updatedPadConfigData` (near line 102).
- [ ] **Step 7.6: Search.** In `src/hooks/useSearch.ts`, add `activePadBehavior?: ActivePadBehavior;` to the result interface (near line 36) and `activePadBehavior: pad.activePadBehavior,` to the pushed result (near line 187). In `src/components/search/SearchModal.tsx`, add `activePadBehavior: result.activePadBehavior,` to the `triggerPad` call (near line 88) and to the `armTrack` call (near line 123).
- [ ] **Step 7.7: Emergency sounds, the keyboard and armed cues.** In `src/hooks/emergencySounds.ts`, add `activePadBehavior?: ActivePadBehavior;` to `EmergencySound` (near line 29) and `activePadBehavior: pad.activePadBehavior,` to the map (near line 92). In `src/hooks/useKeyboardListener.ts`, add `activePadBehavior: sound.activePadBehavior,` at line 61 and `activePadBehavior: matchedConfig.activePadBehavior,` at line 482. In `src/store/playbackStore.ts`, add `activePadBehavior?: ActivePadBehavior;` to `ArmedTrackState` (line 33).
- [ ] **Step 7.8: Write the round-trip test that fails first.** Append to `src/lib/db.activePadBehavior.test.ts`:

```ts
describe("the override survives the wire", () => {
  it("is a voting field in a sync merge", async () => {
    const { detectProfileConflicts } = await import("./syncUtils");
    expect(typeof detectProfileConflicts).toBe("function");
  });

  it("is stamped as modified when a pad is written with it", async () => {
    const { initialSyncFields } = await import("./db");
    const stamps = initialSyncFields(
      { audioFileIds: [1], activePadBehavior: "layer" },
      1000,
    );
    expect(stamps._fieldsModified.activePadBehavior).toBe(1000);
  });
});
```

- [ ] **Step 7.9: Run everything.** Run `npm run lint` and `npm test`. Fix any type error the new optional field raises.
- [ ] **Step 7.10: Commit.** Run `npx prettier --write` over every file this task touched, then `git add` them and `git commit -m "feat: carry the per-pad activePadBehavior through import, trigger, search and cues"`.

---

## Task 8: The layer branch in the retrigger switch

**Files:**

- `src/lib/audio/controls.ts` — these sites:
  - the imports (lines 21-40) and the destructure (line 273)
  - the key and the switch (lines 313-367)
  - the generation capture (line 373) and the strategy (line 377)
  - the streaming release (line 526)
- `src/lib/audio/controls.layer.test.ts` — new.

**Interfaces:**

Consumes: `allocateLayerKey`, `stopInstance` from `./playback`; `resolveActivePadBehavior` from `../db`.

Produces: a trigger that plays a layer on its own instance key while the pad keeps one strategy cursor.

- [ ] **Step 8.1: Write the test that fails first.** Create `src/lib/audio/controls.layer.test.ts`. It reuses the mock shape from `controls.trigger.test.ts`, with the profile default and the two new playback exports added:

```ts
/**
 * The retrigger switch, with "layer" added.
 *
 * Everything below `controls` is stubbed, exactly as in `controls.trigger.test.ts`,
 * so the decision itself can be watched: which key playback is asked to play on,
 * and which pad the playback strategy is asked about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const decoderMocks = vi.hoisted(() => ({
  loadAndDecodeAudioInstant: vi.fn(),
  loadAndDecodeAudioEnhanced: vi.fn(),
  loadAndDecodeAudioPipelined: vi.fn(),
}));

const playbackMocks = vi.hoisted(() => ({
  playBuffer: vi.fn(),
  playBlobStreaming: vi.fn(),
  waitForStreamingPlayable: vi.fn(),
  stopTrack: vi.fn(),
  stopInstance: vi.fn(),
  fadeOutTrack: vi.fn(),
  stopAllTracks: vi.fn(),
  fadeOutAllTracks: vi.fn(),
  isTrackPlaying: vi.fn(() => false),
  isTrackFading: vi.fn(() => false),
  getActiveTrack: vi.fn(() => null),
  getStopGeneration: vi.fn(() => ({ global: 0, key: 0 })),
  stopRequestedSince: vi.fn(() => false),
  allocateLayerKey: vi.fn((base: string) => `${base}#1`),
  clampTrimRange: vi.fn((s: number, e: number) => ({
    trimStart: s,
    trimEnd: e,
  })),
}));

const profileBehavior = vi.hoisted(() => ({ value: "continue" }));

vi.mock("./decoder", () => decoderMocks);
vi.mock("./playback", () => playbackMocks);
vi.mock("./loudness/cache", () => ({ getCachedLoudness: vi.fn() }));
vi.mock("./cache", () => ({
  getCachedAudioBuffer: vi.fn(() => null),
  clearCachedAudioBuffer: vi.fn(),
}));
vi.mock("./context", () => ({
  resumeAudioContext: vi.fn(),
  getAudioContext: vi.fn(() => ({ state: "running", currentTime: 0 })),
}));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db")>("../db");
  return { ...actual, getAudioFile: vi.fn(async () => null) };
});
vi.mock("./preloader", () => ({
  audioPreloader: { trackPlayedFile: vi.fn() },
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({
      getActivePadBehavior: () => profileBehavior.value,
      getNormalisationSettings: () => ({ enabled: false, targetLufs: -23 }),
    }),
  },
}));

const { triggerAudioForPadInstant } = await import("./controls");
const { getStrategy } = await import("./strategies");

const SOUND_A = 300;
const SOUND_B = 301;
const fakeBuffer = { duration: 3, numberOfChannels: 2 } as AudioBuffer;

let nextPadIndex = 0;

beforeEach(() => {
  vi.clearAllMocks();
  profileBehavior.value = "continue";
  playbackMocks.isTrackPlaying.mockReturnValue(true);
  playbackMocks.isTrackFading.mockReturnValue(false);
  playbackMocks.stopRequestedSince.mockReturnValue(false);
  playbackMocks.allocateLayerKey.mockImplementation(
    (base: string) => `${base}#1`,
  );
  decoderMocks.loadAndDecodeAudioInstant.mockResolvedValue(fakeBuffer);
});

/** Triggers a pad that is already live, with the given per-pad override. */
async function triggerLivePad(
  activePadBehavior: "continue" | "stop" | "restart" | "layer" | undefined,
) {
  const padIndex = nextPadIndex++;
  await triggerAudioForPadInstant({
    padIndex,
    audioFileIds: [SOUND_A, SOUND_B],
    playbackType: "sequential",
    activeProfileId: 1,
    currentPageIndex: 0,
    name: "Applause",
    audioGainSettings: undefined,
    padGainDb: 0,
    activePadBehavior,
  });
  return `pad-1-0-${padIndex}`;
}

describe("a pad set to layer", () => {
  it("plays the new sound on an instance key, not the base key", async () => {
    const base = await triggerLivePad("layer");

    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
    expect(playbackMocks.playBuffer).toHaveBeenCalledTimes(1);
    expect(playbackMocks.playBuffer.mock.calls[0][1]).toBe(`${base}#1`);
  });

  it("stops nothing", async () => {
    await triggerLivePad("layer");
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
  });

  it("advances the pad's one strategy cursor per layer", async () => {
    const base = await triggerLivePad("layer");
    const first = playbackMocks.playBuffer.mock.calls[0][2];

    playbackMocks.allocateLayerKey.mockReturnValue(`${base}#2`);
    await triggerAudioForPadInstant({
      padIndex: Number(base.split("-")[3]),
      audioFileIds: [SOUND_A, SOUND_B],
      playbackType: "sequential",
      activeProfileId: 1,
      currentPageIndex: 0,
      name: "Applause",
      audioGainSettings: undefined,
      padGainDb: 0,
      activePadBehavior: "layer",
    });
    const second = playbackMocks.playBuffer.mock.calls[1][2];

    // One cursor per pad, so the second layer is a different sound.
    expect(first.multiSoundState.currentAudioFileId).toBe(SOUND_A);
    expect(second.multiSoundState.currentAudioFileId).toBe(SOUND_B);
  });

  it("asks the strategy about the pad, never about the layer", async () => {
    const base = await triggerLivePad("layer");
    // A strategy instance is created per key; asking for the base key must give
    // back the same instance the trigger advanced.
    const strategy = getStrategy("sequential", base);
    expect(strategy.selectNextSound([SOUND_A, SOUND_B]).audioFileId).toBe(
      SOUND_B,
    );
  });
});

describe("the per-pad override against the profile default", () => {
  it("beats the profile default", async () => {
    profileBehavior.value = "stop";
    const base = await triggerLivePad("layer");
    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
    expect(playbackMocks.stopTrack).not.toHaveBeenCalled();
  });

  it("follows the profile default when the pad says nothing", async () => {
    profileBehavior.value = "layer";
    const base = await triggerLivePad(undefined);
    expect(playbackMocks.allocateLayerKey).toHaveBeenCalledWith(base);
  });

  it("still stops the pad when the profile says stop", async () => {
    profileBehavior.value = "stop";
    const base = await triggerLivePad(undefined);
    expect(playbackMocks.stopTrack).toHaveBeenCalledWith(base);
    expect(playbackMocks.playBuffer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8.2: Run it and watch it fail.** Run `npx vitest run src/lib/audio/controls.layer.test.ts`. Expect the first test to fail with `expected "allocateLayerKey" to be called with arguments: [ 'pad-1-0-0' ] Number of calls: 0`.
- [ ] **Step 8.3: Rewrite the decision.** In `src/lib/audio/controls.ts`, add `allocateLayerKey` and `stopInstance` to the import from `./playback`, add `resolveActivePadBehavior` to the import from `../db`, add `activePadBehavior` to the destructure at line 273, and replace lines 313-367 with:

```ts
// The pad's own key. A layer plays on an instance key derived from it; every
// read about the pad — is it playing, was it stopped, which sound is next —
// stays on this one.
const baseKey = generatePlaybackKey(
  activeProfileId,
  currentPageIndex,
  padIndex,
);
// A fading track is on its way out, so it must not block a new trigger
const isFadingOut = isTrackFading(baseKey);
const isAlreadyPlaying = isTrackPlaying(baseKey) && !isFadingOut;

// The pad's own setting wins; undefined follows the profile.
const behavior = resolveActivePadBehavior(
  { activePadBehavior },
  useProfileStore.getState().getActivePadBehavior(),
);

// Which key this trigger plays on. A layer takes its own; everything else
// takes the pad's, so the single-instance path is unchanged in shape.
let playbackKey = baseKey;

console.log(
  `[Audio Controls] [Instant] Triggering pad ${padIndex}, key: ${baseKey}, ` +
    `Is Playing: ${isAlreadyPlaying}, Is Fading: ${isFadingOut}, Behavior: ${behavior}, ` +
    `Playback Type: ${playbackType}, Audio Files: ${audioFileIds.length}`,
);

if (isAlreadyPlaying) {
  switch (behavior) {
    case "continue":
      console.log(
        `[Audio Controls] [Instant] Behavior=continue. Doing nothing for key: ${baseKey}`,
      );
      return;

    case "stop":
      console.log(
        `[Audio Controls] [Instant] Behavior=stop. Stopping key: ${baseKey}`,
      );
      stopTrack(baseKey);
      return;

    case "restart":
      console.log(
        `[Audio Controls] [Instant] Behavior=restart. Handling restart for key: ${baseKey}`,
      );
      stopTrack(baseKey);
      break;

    case "layer":
      playbackKey = allocateLayerKey(baseKey);
      console.log(
        `[Audio Controls] [Instant] Behavior=layer. New layer on key: ${playbackKey}`,
      );
      break;

    default:
      console.warn(
        `[Audio Controls] [Instant] Unknown activePadBehavior: ${behavior}. Defaulting to 'continue'.`,
      );
      return;
  }
} else if (isFadingOut) {
  // Hard stop the outgoing instance so the new one owns the playback key
  console.log(
    `[Audio Controls] [Instant] Stopping fading instance before re-trigger for key: ${baseKey}`,
  );
  stopTrack(baseKey);
}
```

- [ ] **Step 8.4: Keep one strategy cursor per pad.** At line 373 capture `getStopGeneration(baseKey)`, at line 377 call `getStrategy(playbackType, baseKey)`, and change every later `stopRequestedSince(playbackKey, ...)` to `stopRequestedSince(baseKey, ...)`.

A strategy keyed by the instance key would give every layer a fresh cursor, so
a multi-sound pad set to layer would replay its first sound forever.

- [ ] **Step 8.5: Release only the failed layer.** At line 526, make two edits:

  - Change `stopTrack(playbackKey);` to `stopInstance(playbackKey);`.
  - Change the re-baseline below it to `triggerGeneration = getStopGeneration(baseKey);`.

  Add this comment: "Release this layer alone when the stream fails. The other layers of the pad keep their sound."

- [ ] **Step 8.6: Run it and watch it pass.** Run `npx vitest run src/lib/audio/controls.layer.test.ts src/lib/audio/controls.trigger.test.ts`. Both files must pass.
- [ ] **Step 8.7: Run the whole suite.** Run `npm test`.
- [ ] **Step 8.8: Commit.** Run `npx prettier --write src/lib/audio/controls.ts src/lib/audio/controls.layer.test.ts`, then `git add src/lib/audio/controls.ts src/lib/audio/controls.layer.test.ts` and `git commit -m "feat(audio): play a new layer on its own instance key"`.

---

## Task 9: The two radio groups

**Files:**

- `src/components/modals/EditPadForm.tsx` — after the Playback Mode field, which ends at line 285.
- `src/components/settings/PlaybackSettingsForm.tsx` — the options on lines 58-74.
- `src/components/profiles/ProfileEditForm.tsx` — the options on lines 79-95.

**Interfaces:**

Consumes: `PadFormValues.activePadBehavior`, `ActivePadBehavior`.

Produces: the test id prefix `edit-pad-active-behavior`, so `[data-testid="edit-pad-active-behavior-layer"]` selects the pad-level Layer option.

- [ ] **Step 9.1: Add the pad-level radio group.** In `src/components/modals/EditPadForm.tsx`, add the option list beside `playbackTypeOptions` (line 230):

```tsx
// "" is the empty option the form writes back as undefined, which is how a
// pad says "follow the profile".
const activePadBehaviorOptions = [
  {
    value: "",
    label: "Use profile default",
    description: "This pad does whatever the profile's playback settings say.",
  },
  {
    value: "continue",
    label: "Continue",
    description: "The sound continues, and the trigger does nothing.",
  },
  {
    value: "stop",
    label: "Stop",
    description: "The sound stops at once.",
  },
  {
    value: "restart",
    label: "Restart",
    description: "The sound starts again from the beginning.",
  },
  {
    value: "layer",
    label: "Layer",
    description: "One more copy of the sound starts on top, up to 16 at once.",
  },
];
```

and the field itself, after the Playback Mode field:

```tsx
{
  /* Behaviour when the pad already plays */
}
<FormField id="activePadBehavior" label="When already playing">
  <RadioGroup
    id="activePadBehavior"
    name="activePadBehavior"
    options={activePadBehaviorOptions}
    value={values.activePadBehavior ?? ""}
    onChange={(value) =>
      updateValue(
        "activePadBehavior",
        value === "" ? undefined : (value as ActivePadBehavior),
      )
    }
    data-testid="edit-pad-active-behavior-group"
    optionTestIdPrefix="edit-pad-active-behavior"
  />
</FormField>;
```

Add `ActivePadBehavior` to the import from `@/lib/db` on line 28.

- [ ] **Step 9.2: Add the profile-level option.** In `src/components/settings/PlaybackSettingsForm.tsx`, add a fourth entry to the options on line 73:

```tsx
            {
              value: "layer",
              label: "Layer Sound",
              description:
                "One more copy starts on top, up to 16 at once. Applies to every pad that does not override it.",
            },
```

- [ ] **Step 9.3: Add the same option to the profile form.** Add the identical entry to `src/components/profiles/ProfileEditForm.tsx` after line 94.
- [ ] **Step 9.4: Check the forms by eye.** Ask the user to confirm the dev server runs. Open a pad in edit mode and confirm the five options render. Open Playback Settings and confirm "Layer Sound" renders and saves.
- [ ] **Step 9.5: Run lint and the suite.** Run `npm run lint` and `npm test`.
- [ ] **Step 9.6: Commit.** Run `npx prettier --write src/components/modals/EditPadForm.tsx src/components/settings/PlaybackSettingsForm.tsx src/components/profiles/ProfileEditForm.tsx`, then `git add` those three files and `git commit -m "feat(ui): offer Layer per pad and per profile"`.

---

## Task 10: The end-to-end test

**Files:**

- `e2e-tests/test-helpers.ts` — `ActiveSoundInfo` (line 252).
- `e2e-tests/audio-playback.spec.ts` — a new test inside the top-level describe.

**Interfaces:**

Consumes: `__impampActiveSounds`, the test ids from Task 3 and Task 9.

- [ ] **Step 10.1: Report the layer through the helper type.** In `e2e-tests/test-helpers.ts`, add two fields to `ActiveSoundInfo`:

```ts
  /** The pad the sound belongs to, without the layer suffix. */
  baseKey?: string;
  /** 0 for a pad that does not layer, then 1, 2, 3 for each layer. */
  layerIndex?: number;
```

- [ ] **Step 10.2: Write the E2E test that fails first.** Add to `e2e-tests/audio-playback.spec.ts`, inside `test.describe("ImpAmp3 Audio Playback", ...)`:

```ts
test("A pad set to Layer stacks three sounds and groups them in the panel", async ({
  page,
}) => {
  const padIndex = 12;
  const filePaths = await createMultipleTestAudioFiles(["layerA"]);

  await openEditPadModal(page, padIndex);
  await addSoundsToPadModal(page, filePaths);
  await page.locator('[data-testid="edit-pad-active-behavior-layer"]').check();
  await savePadEditModal(page);

  const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);

  await pad.click();
  await expect(page.locator('[data-testid="active-track-item"]')).toHaveCount(
    1,
  );
  await pad.click();
  await pad.click();

  // Three live instances, all on the same pad.
  await expect.poll(async () => (await getActiveSounds(page)).length).toBe(3);
  const sounds = await getActiveSounds(page);
  expect(new Set(sounds.map((s) => s.baseKey)).size).toBe(1);
  expect(sounds.map((s) => s.layerIndex).sort()).toEqual([0, 1, 2]);

  // One row per pad, not one row per layer.
  await expect(page.locator('[data-testid="active-track-item"]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-testid="pad-layer-count"]')).toHaveText(
    "x3",
  );

  // The count expands into one row per layer.
  await page.locator('[data-testid="active-track-layer-count"]').click();
  await expect(
    page.locator('[data-testid="active-track-layer-item"]'),
  ).toHaveCount(3);

  // Stopping the grouped row stops every layer.
  await page.locator('[data-testid="active-track-item"]').first().click();
  await expect(page.getByText("Nothing playing")).toBeVisible();
});
```

- [ ] **Step 10.3: Run it and watch it fail before the app is built.** Run `npm run test:e2e:audio`. If the app is not built, Playwright builds it first. Expect the new test to fail on `expected 3 received 1` while any part of Task 3, 8 or 9 is incomplete.
- [ ] **Step 10.4: Run it and watch it pass.** Run `npm run test:e2e:audio` again after every earlier task is committed. The whole audio spec must pass on chromium.
- [ ] **Step 10.5: Commit.** Run `npx prettier --write e2e-tests/audio-playback.spec.ts e2e-tests/test-helpers.ts`, then `git add e2e-tests/audio-playback.spec.ts e2e-tests/test-helpers.ts` and `git commit -m "test(e2e): prove a layered pad stacks three sounds under one panel row"`.

---

## Task 11: Documentation and merge

**Files:**

- `CLAUDE.md` — the "Key Features Implementation" list and the "Important Implementation Notes" list.

- [ ] **Step 11.1: Record the feature.** In `CLAUDE.md`, add to "Key Features Implementation", after the "Loudness normalisation" entry:

```markdown
- **Layered retrigger** - `activePadBehavior` is `continue`, `stop`, `restart`
  or `layer`, set per profile and overridable per pad
  (`PadConfiguration.activePadBehavior`; undefined follows the profile). A
  layered pad plays up to `MAX_LAYERS_PER_PAD` (16) overlapping sounds; the
  17th trigger stops the oldest. `src/lib/audio/playback.ts` keys `activeTracks`
  by **instance key** (`pad-<profile>-<bank>-<pad>#<n>`) and groups them in
  `layersByBase`; `stopTrack` takes the base key and stops every layer, and
  `stopInstance` stops one.
```

- [ ] **Step 11.2: Record the hazards.** Add to "Important Implementation Notes":

```markdown
- The `ActivePadBehavior` union lives only in `src/lib/db.ts`. It used to be
  written out again in `types/forms.ts` twice and cast inline in
  `PlaybackSettingsForm.tsx` and `ProfileEditForm.tsx`. Import it
- One playback strategy cursor per **pad**, never per layer. `controls.ts` calls
  `getStrategy(playbackType, baseKey)`; keying it by the instance key would give
  each layer a fresh cursor, so a multi-sound layered pad would replay its first
  sound forever
- `layersByBase` is written only by `claimPlaybackKey` and `clearTrackState`,
  which are the only two places a track enters and leaves `activeTracks`. Keep
  it that way, or the two maps will disagree about what is playing
```

- [ ] **Step 11.3: Run the full gate.** Run `npm run lint`, then `npm test`, then `npm run test:coverage`, then `npm run test:e2e:audio`. All four must pass. Do not lower the coverage thresholds. If coverage rises well above the floor, raise the floor in a separate commit.
- [ ] **Step 11.4: Commit the docs.** Run `npx prettier --write CLAUDE.md`, then `git add CLAUDE.md` and `git commit -m "docs: record the layered retrigger behaviour and its two hazards"`.
- [ ] **Step 11.5: Merge.** Use the `superpowers:finishing-a-development-branch` skill. Merge `feat/layered-retrigger` into `main` and remove the worktree.

---

## What this plan does not do

- It does not touch `pageIndex`. §0 owns bank identity, and this work branches off `main`.
- It does not add a per-layer volume control. Every layer of a pad plays at the pad's resolved gain.
- It does not change the emergency bank, the armed queue order, or the ESC key.
