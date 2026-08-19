# Design: bank identity, bank export/import, reordering, and layered retrigger

Date: 2026-08-19
Status: awaiting review

Three features, plus one schema change that two of them depend on.

Feature 2 requires separating a bank's **identity** from its **position**.
That change (§0) lands first; features 1 and 2 build on it. Feature 3 is
independent of all of it.

---

## 0 — Bank identity: `bankId`

### The problem

`pageIndex` is three things at once: a bank's identity in every DB key and
in the sync blob, its position in the tab strip, and its keyboard shortcut
(index 3 is key "4"; index 12 is Ctrl+3). Reordering has to change
position without changing identity, which today is impossible because
they are the same integer.

Leaving them conflated and rotating bank _contents_ between fixed index
slots was considered and rejected. It works mechanically, but it does not
preserve identity across a reorder, so a rename made concurrently on
another device lands on whichever bank now occupies that slot — silently,
with no conflict raised.

### The change

```ts
// PageMetadata
bankId: string; // immutable identity
pageIndex: number; // position only: tab order and keyboard shortcut

// PadConfiguration
bankId: string; // replaces pageIndex as the link to its bank
```

`padConfigurations`' unique index moves from
`[profileId, pageIndex, padIndex]` to `[profileId, bankId, padIndex]`.
`pageMetadata` keeps a unique index on `[profileId, bankId]`; the index on
`[profileId, pageIndex]` is dropped, because two banks may transiently
share a position during a merge (see "Order normalisation" below).

The sync merge key extractors become the one-line changes:

```ts
const padConfigKeyExtractor = (item) => `${item.bankId}-${item.padIndex}`;
const pageMetaKeyExtractor = (item) => item.bankId;
```

### Migration (DB v7)

**Migrated banks take `bankId = String(pageIndex)`. Only banks created
after the migration get `crypto.randomUUID()`.**

This is not a convenience. The migration is client-side IndexedDB code, so
it runs once per device, independently, against identical starting data —
there is no server step and no way to elect one device to migrate for
everyone. With random ids, device A mints `uuid-X` for a bank and device B
mints `uuid-Y` for the same bank; the merge keys on identity, sees two,
and keeps both. Every migrated bank would duplicate itself. A
deterministic id makes migrating twice on two machines a no-op instead of
a fork. Banks created _after_ the migration are safe with random ids,
because creation is a synced event and cannot diverge.

The migration must also **materialise the implicit banks**. Banks 1–10 are
synthesised client-side by `page.tsx:98-106` when no `pageMetadata` row
exists, so pads can sit at `pageIndex` 0–9 with no page record at all. The
migration walks every distinct `pageIndex` present in `padConfigurations`,
creates any missing `pageMetadata` row (name defaulted exactly as
`upsertPageMetadata` does today), then stamps `bankId` onto every page and
pad. A pad left without a `bankId` would disappear from its bank, so this
ordering is not optional.

`pageIndex` stays on `PageMetadata` as position. It is **removed** from
`PadConfiguration` — a pad's position is its bank's position, and keeping
a second copy is exactly the duplicated-rule shape that drifts.

### Order normalisation

With position as an ordinary per-bank field, per-field last-write-wins
across two devices that both reordered can leave duplicate or gappy
`pageIndex` values. Order is therefore normalised on read: sort by
`(pageIndex, bankId)` and densely renumber from 0. `bankId` is stable, so
every device computes the same order from the same blob.

### Version window

All clients are web clients and pick up a deploy on their next load, and
there are about ten of them, so no compatibility layer is built: no
dual-key emission, no positional fallback, no version negotiation. If an
old client is still running when someone reorders, its banks look
shuffled until it reloads. Worth knowing rather than engineering around:
the service worker means updates never apply to a running page, and this
is an offline-capable PWA, so a client can lag.

### Everything keyed on `pageIndex` today

These move to `bankId` and are the checklist for this phase:
`db.ts` (`getPadConfigurationsForProfilePage`, `swapPadConfigurations`,
`replaceMissingAudioFile`, `upsertPageMetadata`, `duplicateProfile`),
`syncUtils.ts` (both key extractors, conflict keys, diff summary),
`googleDrive/dataAccess.ts` (pad and page write-back maps, and the
delete-what-is-absent pass at 559-563, which becomes identity-based and so
stops being a hazard), `importExport.ts`, and the runtime key builders in
`audio/types.ts`, `loadingStore.ts`, `playbackStore.ts`, `preloader.ts`,
`usePadConfigurations.ts`, `emergencySounds.ts` and
`loudness/overview.ts`. Keyboard bank switching in `useKeyboardListener.ts`
and `bankUtils.ts` keeps using `pageIndex`, because that is position and
position is what a hotkey selects.

### Tests

- Migration: a profile with pads at indices with no page row gains rows
  and every pad gets a `bankId`; running the migration twice is a no-op;
  two independently-migrated copies of the same profile merge to one set
  of banks, not two.
- Merge: rename on one device plus reorder on another leaves the rename on
  the bank it was made on.
- Normalisation: duplicate and gappy `pageIndex` values resolve to the
  same dense order on two devices.

---

## 1 — Bank-specific export and import

Export one bank as a self-contained `.iaz` archive; import it into the
**active** profile as a new bank or over an existing one.

### Format

Reuses the profile archive's layout with a new manifest version, so the
two are distinguishable without heuristics.

```jsonc
// manifest.json
{
  "exportVersion": 4,
  "exportDate": "2026-08-19T…",
  "banks": [{ "name": "Stings", "folder": "0", "sourceProfileName": "Show A" }],
}
```

```ts
// banks/0/bank.json
export interface BankExport {
  exportVersion: 4;
  exportDate: string;
  /** Identity of the bank this was exported from, for the update-in-place offer. */
  sourceBankId: string;
  /** pageIndex is advisory; import chooses the position. */
  page: Omit<PageMetadata, "id" | "profileId" | "bankId" | "pageIndex">;
  padConfigurations: Omit<PadConfiguration, "id" | "profileId" | "bankId">[];
  audioFiles: AudioFileRef[];
}
```

`audio/<audioFileId>` entries are byte-identical to the profile export's,
so `importAudioSources` is reused unchanged. The `.iaz` extension and the
file input's `accept` list do not change; the manifest version routes it.

### Export

`collectBankDataForZip(profileId, bankId)` factored out of the existing
`collectProfileDataForZip` (the audio-collection half is shared), and
`exportBankToZip(...)` mirroring `exportProfilesToZip` including the
`showSaveFilePicker` streaming path and the blob fallback. Filename
`impamp-bank-<sanitised name>-<YYYY-MM-DD>.iaz`.

It does **not** stamp `lastBackedUpAt`: one bank is not a backup of the
profile, and claiming otherwise would suppress the backup reminder on data
that was never exported.

### Import

Two-phase, because the slot must be chosen before anything is written.

1. `readArchiveManifest(blob)` opens the ZIP, reads `manifest.json` only,
   and returns `{ kind: "profiles" }` or `{ kind: "bank", bank }` where
   `bank` is `{ name, isEmergency, padCount, audioCount, sourceProfileName,
sourceBankId }`.
2. The UI prompts, then calls `importBankFromZip(blob, db, { profileId,
mode })` with `mode` of `{ kind: "add" } | { kind: "replace", bankId }`.

`"add"` mints a new `bankId` and appends at the first free position.
`"replace"` keeps the target's `bankId`, clears its existing pads, and
writes the incoming ones. If `sourceBankId` matches a bank already in the
profile, the dialog defaults to replacing that bank.

Audio id remapping goes through the existing `importAudioSources` and
`remapPadSettingsOnImport` — never by hand, per the five-places warning in
`CLAUDE.md`. Rollback snapshots the target bank's rows in memory before
the first write and restores them on failure, and removes any audio
created during the attempt via `deleteUnreferencedAudioFiles`.

### UI

**Export** — Manage Profiles → Import / Export gains a third section,
"Export a single bank": a profile select (defaulting to active), a bank
select, an "Export Bank" button reusing `TransferProgressBar`.

**Import** — the existing file input is unchanged. A bank archive raises:

```
Import bank "Stings"
12 pads, 9 sounds — from profile "Show A"

Into profile: Show A (active)

  ( ) Add as a new bank        -> position 13
  ( ) Replace an existing bank -> [ 4: SFX  v ]

                              [ Cancel ]  [ Import ]
```

Target profile is fixed to the active profile and shown read-only.
"Add as a new bank" is disabled, with a reason, when all 20 slots are full.

### Tests

Unit, on `importExport.zip.test.ts`'s harness: round trip preserves pad
names, sounds, trim, per-sound and per-pad gain (re-keyed onto new audio
ids), playback type, `isDisabled`, bank name and emergency flag; `"add"`
lands at the first free position with a fresh `bankId`; `"replace"` keeps
the target `bankId` and clears pads the incoming bank does not define; a
malformed archive is refused without mutating the profile; rollback
restores the prior bank. E2E: export a bank, import it back, assert the
grid.

---

## 2 — Reordering banks by dragging tabs in edit mode

On top of §0 this is small: a reorder writes `pageIndex` on the affected
`pageMetadata` rows and touches nothing else. No pad row moves, no unique
index is stressed, and identity is preserved, so the merge sees a position
change rather than a mass rename.

```ts
export async function reorderBanks(
  profileId: number,
  orderedBankIds: string[],
): Promise<void>;
```

One transaction over `pageMetadata`, assigning dense `pageIndex` values in
the given order and stamping `_modified` / `_fieldsModified` on each row
whose position actually changed.

### Interaction

`@hello-pangea/dnd` v18 is already a dependency and already reorders
sounds in `EditPadForm.tsx`; the tab strip uses the same primitives with
`direction="horizontal"`.

- Dragging is enabled only in edit mode, where "+ Add Bank" and tab
  renaming already live.
- Shift+click still opens the bank edit modal; the library distinguishes a
  click from a drag, and the existing handler moves onto the drag handle.
- On drop: `reorderBanks` → `incrementPadConfigsVersion()` →
  `requestSync()`, the trio `handleBankClick` already runs.
- The view follows the bank you dragged, so you stay on the bank you were
  looking at rather than on the slot number.
- Keyboard reorder comes free (space to lift, arrows, space to drop),
  which matters because the strip is a `role="tablist"`.
- Playback keys are `bankId`-based after §0, so reordering while sound is
  playing no longer orphans tracks or armed cues.

### The honest cost

Every hotkey between source and destination changes meaning. That is
inherent in "keys follow position" and is the chosen behaviour; tabs print
their bank number, so the new mapping is visible immediately.

### Tests

Unit: reorder right and left; a no-op order writes nothing; positions stay
dense; only moved rows get fresh sync stamps; bank contents, names and
emergency flags are untouched. E2E: drag a tab in edit mode, assert tab
order, that pads followed, and that the hotkey selects the new occupant.

---

## 3 — "Layer" as an already-playing behaviour

Independent of §0; can be built in parallel.

### Setting

```ts
export type ActivePadBehavior = "continue" | "stop" | "restart" | "layer";

// PadConfiguration
/** Overrides the profile's activePadBehavior. Undefined = follow the profile. */
activePadBehavior?: ActivePadBehavior;
```

Per-profile default, per-pad override. Undefined means "follow the
profile", so no migration is needed and existing pads behave as today.

The union is currently duplicated verbatim in five places rather than
imported (`types/forms.ts` twice, plus inline casts in
`PlaybackSettingsForm.tsx` and `ProfileEditForm.tsx`). This work imports
the type in all of them instead of adding a fourth copy of the string.

The new field is added to `PadPlaybackSettings` /
`extractPadPlaybackSettings` (`db.ts:1464`), `TriggerablePad`,
`TriggerAudioArgs` and the sync/import field lists — otherwise the
override is silently dropped by pad swap, profile duplication, export and
sync.

### Engine

`activeTracks` is keyed by `pad-<profile>-<bank>-<pad>`, and
`claimPlaybackKey` deliberately silences any track it displaces. Layering
adds an instance dimension:

- The pad key becomes the **base** key; a layered instance is tracked under
  `` `${baseKey}#${n}` ``. Non-layered pads keep using the bare base key,
  so the existing single-instance path is unchanged in shape.
- `layersByBase: Map<string, string[]>` holds instance keys in start order.
- `isTrackPlaying` / `isTrackFading` / `getActiveTrack` resolve through the
  base key and report on **any** instance, so `controls.ts`'s retrigger
  decision keeps working unmodified.
- `stopTrack(baseKey)` stops every instance; a new
  `stopInstance(instanceKey)` stops exactly one. `stopAllTracks` /
  `fadeOutAllTracks` iterate instances, so ESC still kills everything.
- Stop generations become per **base** key.
- `claimPlaybackKey`'s displacement warning stays for non-layer modes; it
  is asserted by `playback.race.test.ts:104` and remains correct.

### Cap

Hard cap of **16** layers per pad, as a named constant. The 17th trigger
stops the oldest layer and starts a new one, so a trigger always makes a
sound. Held keys cannot stack — `useKeyboardListener.ts:162` and
`Pad.tsx:384` already return early on `event.repeat`. Verified; no change.

### UI

**Active Tracks** — grouped by base key, one row per pad, the layer count
rendered as a button that expands into one indented row per layer:

```
  Applause                     (x3)  0:12        collapsed
  Rain loop                          1:04

  Applause                     (v3)  0:12        expanded
    -- layer 1                       0:12
    -- layer 2                       0:07
    -- layer 3                       0:02
```

Collapsed by default; expansion is local component state. Stopping the
grouped row stops all layers; each layer row stops one.
`playbackStore` keys by instance key with a selector folding instances
into per-pad groups — `PlaybackState.padInfo` already carries what the
fold needs.

**Pad** — ring and remaining time follow the newest layer; the pad stays
lit while any layer plays; a count badge appears above one layer.

**Live region** — `PlaybackAnnouncer` says "Applause, 3 layers" rather
than repeating the name.

**Pad edit form** — a "When already playing" `RadioGroup` beside Playback
Mode: _Use profile default_ / _Continue_ / _Stop_ / _Restart_ / _Layer_,
with the per-option descriptions `RadioGroup` already supports.

**Playback settings** — "Layer" as a fourth profile-level radio, described
as applying to every pad that does not override it.

### Tests

Unit: two triggers on a layer pad yield two live instances (the inverse of
`playback.race.test.ts:104`, which stays true for non-layer modes); the
17th trigger stops the oldest and the count holds at 16; `stopTrack` on
the base key kills all layers, `stopInstance` kills one, ESC kills
everything; a per-pad override beats the profile default and an undefined
override follows it; the strategy cursor advances once per layer, so a
multi-sound layered pad plays a different sound per layer. E2E on
`audio-playback.spec.ts`: set a pad to layer, trigger three times, assert
three `__impampActiveSounds` entries and the grouped-then-expanded rows.

---

## Sequencing

§0 lands first, on its own branch, with the full suite green — it is a
schema migration and a sync-format change, and nothing else should be in
that diff. Features 1 and 2 branch off it afterwards and are independent
of each other. Feature 3 branches off `main` today and merges whenever.

Within feature 3, the `playbackStore` key-space change lands first with
existing tests green, before layering is switched on: `Pad.tsx`,
`ActiveTracksPanel`, `PlaybackAnnouncer` and the `__impampActiveSounds`
E2E hook all read that store, and that refactor is the riskiest piece.

Docs update in the same commits as the code: `CLAUDE.md`'s Import/Export
and Key Features sections, and a `docs/server-sync.md` note recording that
bank identity is `bankId` and position is `pageIndex`.
