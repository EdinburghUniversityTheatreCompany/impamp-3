# Design: bank identity, audio dedup, bank export/import, reordering, layered retrigger

Date: 2026-08-19
Status: awaiting review

Five phases. Two are enabling changes the user never sees directly (§0
bank identity, §1 audio dedup); three are the requested features.

Dependency order: §0 → §3 (reordering). §1 → §2 (bank export/import).
§4 is independent of everything and can be built in parallel from day one.

---

## 0 — Bank identity: `bankId`

### The problem

`pageIndex` is three things at once: a bank's identity in every DB key and
in the sync blob, its position in the tab strip, and its keyboard shortcut
(index 3 is key "4"; index 12 is Ctrl+3). Reordering has to change
position without changing identity, which today is impossible because they
are the same integer.

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
share a position during a merge (see "Order normalisation").

The sync merge key extractors become one-line changes:

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
`PadConfiguration` — a pad's position is its bank's position, and a second
copy is exactly the duplicated-rule shape that drifts.

### Order normalisation

With position as an ordinary per-bank field, per-field last-write-wins
across two devices that both reordered can leave duplicate or gappy
`pageIndex` values. Order is normalised on read: sort by
`(pageIndex, bankId)` and densely renumber from 0. `bankId` is stable, so
every device computes the same order from the same blob.

### Version window

All clients are web clients and pick up a deploy on their next load, and
there are about ten of them, so no compatibility layer is built: no
dual-key emission, no positional fallback, no version negotiation. If an
old client is still running when someone reorders, its banks look shuffled
until it reloads. Worth knowing rather than engineering around: the
service worker means updates never apply to a running page, and this is an
offline-capable PWA, so a client can lag.

### Everything keyed on `pageIndex` today

The checklist for this phase: `db.ts`
(`getPadConfigurationsForProfilePage`, `swapPadConfigurations`,
`replaceMissingAudioFile`, `upsertPageMetadata`, `duplicateProfile`),
`syncUtils.ts` (both key extractors, conflict keys, diff summary),
`googleDrive/dataAccess.ts` (pad and page write-back maps, and the
delete-what-is-absent pass at 559-563, which becomes identity-based and so
stops being a hazard), `importExport.ts`, and the runtime key builders in
`audio/types.ts`, `loadingStore.ts`, `playbackStore.ts`, `preloader.ts`,
`usePadConfigurations.ts`, `emergencySounds.ts`, `loudness/overview.ts`.
Keyboard bank switching in `useKeyboardListener.ts` and `bankUtils.ts`
keeps using `pageIndex`, because that is position and position is what a
hotkey selects.

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

## 1 — Audio deduplication by content hash

### Why now

`addAudioFile` (`db.ts:562`) computes a content hash and then
unconditionally `add`s a new row. `getAudioFileByHash` (`db.ts:734`) and a
`hash` index both exist but no import path consults them. Audio rows are
global, not per-profile, so importing the same sounds twice already
duplicates every blob today.

That is tolerable for profile import, where the data genuinely is new. It
is not tolerable for bank import into an _existing_ profile — the case
where the target most likely already holds the sounds. Re-importing a bank
exported from the same profile would duplicate every blob and repoint the
pads at the copies. Retrofitting dedup after the fact needs a data-repair
migration, so it goes in before §2 rather than after.

### Reuse on write

```ts
addOrReuseAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<{ id: number; reused: boolean }>
```

Looks up `getAudioFileByHash` first and returns the existing row's id when
one matches. Dedup is **not** folded silently into `addAudioFile`, because
callers use its return value to decide what to clean up: import rollback
calls `deleteUnreferencedAudioFiles(createdAudioIds)`, and a rollback must
never delete a row it merely reused. The `reused` flag is what lets the
caller tell those apart.

Applied to every inbound path: profile import, bank import, impamp2 legacy
import, Drive and server sync audio download, and the drag-and-drop of a
file onto a pad (dropping the same file on two pads should reference one
row, not two).

### Consequence: cross-profile sharing becomes load-bearing

Pads in different profiles will now share audio rows. That makes
`deleteUnreferencedAudioFiles`' cross-profile correctness critical rather
than incidental, and it gets direct tests: deleting a profile must not
remove audio another profile still references, and import rollback must
not remove a reused row.

Per-sound gain and trim are keyed by audio id _on the pad_
(`PadConfiguration.audioGainSettings`), so a shared row cannot leak
settings between profiles. Shared loudness analysis is a straight win —
each file is analysed once.

### One-off cleanup

A "Find duplicate audio" action in the Manage Profiles → Maintenance tab,
for the duplication already in the database.

1. `ensureAudioFileHash` over any row lacking a hash.
2. Group rows by hash; for each group of more than one, elect a canonical
   row — prefer one that already carries a loudness analysis, then the
   lowest id.
3. Report a preview before touching anything: number of duplicate groups,
   number of rows to remove, bytes reclaimable.
4. On confirmation, repoint every referencing pad from the duplicates to
   the canonical row and delete the duplicates.

Step 4 rewrites `audioFileIds` **and** the `Record<audioFileId, …>` maps
`audioTrimSettings` and `audioGainSettings`. That is precisely the
five-places hazard `CLAUDE.md` warns about, so it goes through the shared
`remapAudioFileIdKeys` helper rather than any hand-rolled copy, and the
test asserts gain and trim survive the collapse.

This action **deletes audio rows the user did not ask to delete**, so it
is preview-then-confirm, it runs in one transaction, it reports what it
did, and it does not merge without your review.

### Tests

- `addOrReuseAudioFile` returns the existing id and `reused: true` on a
  hash match; a fresh hash creates a row with `reused: false`.
- Import rollback deletes only rows it created.
- Deleting a profile leaves audio another profile references.
- Cleanup collapses a duplicate group, repoints pads, preserves per-sound
  gain and trim, and preserves the loudness analysis on the survivor.
- Cleanup on a database with no duplicates is a no-op.

---

## 2 — Bank export and import

Export any number of banks as a self-contained `.iaz` archive; import them
into the **active** profile, each either as a new bank or over an existing
one.

### Format

Reuses the profile archive's layout with a new manifest version, so the
two are distinguishable without heuristics. `banks` is an array from the
start, so N banks needs no second format.

```jsonc
// manifest.json
{
  "exportVersion": 4,
  "exportDate": "2026-08-19T…",
  "banks": [
    { "name": "Stings", "folder": "0", "sourceProfileName": "Show A" },
    { "name": "Beds", "folder": "1", "sourceProfileName": "Show A" },
  ],
}
```

```ts
// banks/<n>/bank.json
export interface BankExport {
  exportVersion: 4;
  exportDate: string;
  /** Identity of the bank this came from, for the update-in-place offer. */
  sourceBankId: string;
  /** pageIndex is advisory; import chooses the position. */
  page: Omit<PageMetadata, "id" | "profileId" | "bankId" | "pageIndex">;
  padConfigurations: Omit<PadConfiguration, "id" | "profileId" | "bankId">[];
  audioFiles: AudioFileRef[];
}
```

`audio/<audioFileId>` entries are byte-identical to the profile export's
and shared across every bank in the archive, so exporting five banks that
share a sound stores it once. `importAudioSources` is reused unchanged.
The `.iaz` extension and the file input's `accept` list do not change; the
manifest version routes it.

### Export

`collectBankDataForZip(profileId, bankId)` factored out of the existing
`collectProfileDataForZip` (the audio-collection half is shared), and
`exportBanksToZip(profileId, bankIds, target, onProgress?)` mirroring
`exportProfilesToZip`, including the `showSaveFilePicker` streaming path
and the blob fallback.

Filename: `impamp-bank-<sanitised name>-<YYYY-MM-DD>.iaz` for one bank,
`impamp-banks-<n>-<YYYY-MM-DD>.iaz` for several.

It does **not** stamp `lastBackedUpAt`: a selection of banks is not a
backup of the profile, and claiming otherwise would suppress the backup
reminder on data that was never exported.

### Import

Two-phase, because slots must be chosen before anything is written.

1. `readArchiveManifest(blob)` opens the ZIP and returns
   `{ kind: "profiles" }` or `{ kind: "banks", banks }`, each entry
   `{ name, isEmergency, padCount, audioCount, sourceProfileName, sourceBankId }`.
   It reads `manifest.json` **and** each `banks/<n>/bank.json`, because the
   manifest alone cannot supply `padCount`, `isEmergency` or `sourceBankId`.
   It reads no audio entry, so the cost stays inside the metadata cap.
2. The UI prompts, then calls `importBanksFromZip(blob, db, { profileId,
placements })` where `placements` maps each archive folder to
   `{ kind: "add" } | { kind: "replace", bankId } | { kind: "skip" }`.

Internally each placement runs through one core:

```ts
writeBankIntoProfile(db, { profileId, mode, bank, audioSources });
```

`"add"` mints a new `bankId` and appends at the first free position;
`"replace"` keeps the target's `bankId`, clears its pads, and writes the
incoming ones. If `sourceBankId` matches a bank already in the profile,
that bank is the default target and the row is pre-set to replace it.

Factoring the core this way is deliberate: an in-app "merge profile into…"
is then the same core called over another profile's banks, with no file
round trip. That feature is **not** in this spec — it has its own
questions (behaviour at the 20-slot cap, how name collisions read, whether
it is destructive to the source) and gets its own design pass once this
lands.

Audio id remapping goes through `importAudioSources` and
`remapPadSettingsOnImport` — never by hand, per the five-places warning in
`CLAUDE.md`. Audio is deduped by hash via §1, so re-importing a bank into
the profile it came from adds no blobs.

Capacity is checked across the whole set before any write: if the
placements need more free slots than the profile has, the dialog says so
and the Import button stays disabled. Rollback snapshots every target
bank's rows before the first write and restores them all on failure,
removing any audio created (not reused) during the attempt.

### UI

**Export** — Manage Profiles → Import / Export gains a third section,
"Export banks": a profile select (defaulting to active) and a checkbox
list of that profile's banks, mirroring the existing profile checkbox
list, with an "Export Selected (n)" button reusing `TransferProgressBar`.

**Import** — the existing file input is unchanged. A bank archive raises:

```
Import 2 banks from "Show A"          into: Show A (active)

  Stings   12 pads, 9 sounds    [ Add as new bank -> 13  v ]
  Beds      6 pads, 4 sounds    [ Replace: 4: SFX        v ]

  3 free slots available

                                     [ Cancel ]  [ Import ]
```

Target profile is fixed to the active profile and shown read-only. Each
row's dropdown offers "Add as new bank", "Replace <bank>" or "Skip".

### Tests

Unit, on `importExport.zip.test.ts`'s harness: round trip preserves pad
names, sounds, trim, per-sound and per-pad gain (re-keyed onto new audio
ids), playback type, `isDisabled`, bank name and emergency flag; a
multi-bank archive stores a shared sound once and both banks reference it;
`"add"` lands at the first free position with a fresh `bankId`;
`"replace"` keeps the target `bankId` and clears pads the incoming bank
does not define; `"skip"` writes nothing; over-capacity is refused before
any write; a malformed archive is refused without mutating the profile;
rollback restores every target bank. E2E: export two banks, import them
back, assert both grids.

---

## 3 — Reordering banks by dragging tabs in edit mode

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

## 4 — "Layer" as an already-playing behaviour

Independent of §0–§3; can be built in parallel from the start.

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
- Playback strategies stay keyed on the **base** key. Keying them per
  instance would give every layer a fresh cursor, so a multi-sound layered
  pad would replay its first sound forever instead of advancing.
- `stopAudio` and `fadeOutAudio` in `controls.ts` route by the kind of key
  they are given. A layer row in the panel passes an instance key and must
  stop one layer; a pad row passes a base key and must stop them all.

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
grouped row stops all layers; each layer row stops one. `playbackStore`
keys by instance key with a selector folding instances into per-pad
groups — `PlaybackState.padInfo` already carries what the fold needs.

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

```
main ──┬── §0 bank identity ──┬── §3 reordering
       │                      └── (§2 needs §1 too)
       ├── §1 audio dedup ────┴── §2 bank export/import
       └── §4 layered retrigger  (independent throughout)
```

§0 and §1 are both enabling changes and go on their own branches, each
merged with the full suite green before anything builds on it. §0 is a
schema migration and a sync-format change; nothing else belongs in that
diff.

§2 needs both, so it starts once they are merged. §3 needs only §0. §4
branches off `main` today.

Within §4, the `playbackStore` key-space change lands first with existing
tests green, before layering is switched on: `Pad.tsx`,
`ActiveTracksPanel`, `PlaybackAnnouncer` and the `__impampActiveSounds`
E2E hook all read that store, and that refactor is the riskiest piece.

**Pause for review before merging** §1's cleanup action, since it deletes
audio rows, and §0's migration, since it rewrites every pad and page row.

Deferred to its own design pass: **in-app profile merge**, which becomes a
small feature once `writeBankIntoProfile` exists, but needs decisions on
the 20-slot cap, bank name collisions and whether it consumes the source.

Docs update in the same commits as the code: `CLAUDE.md`'s Import/Export
and Key Features sections, and a `docs/server-sync.md` note recording that
bank identity is `bankId` and position is `pageIndex`.
