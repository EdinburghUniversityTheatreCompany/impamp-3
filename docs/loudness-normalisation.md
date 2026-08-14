# ImpAmp3 — Loudness normalisation and gain control

Every sound on a board plays at a consistent level without hand-tuning each
one, and you can still override that level per sound and per pad when the
automatic answer is wrong. Three things make this up:

1. **Automatic loudness normalisation.** Every audio file is analysed once
   against ITU-R BS.1770-4. At playback, a gain is derived that brings the
   sound to the profile's target loudness (default −16 LUFS), never exceeding
   a −1 dBTP true-peak ceiling.
2. **Manual gain, per sound and per pad.** Two independent dB offsets that
   multiply on top of normalisation, so adjusting one never destroys the
   other.
3. **A loudness overview.** A sortable, filterable table of every pad and
   sound on the active profile, showing measured loudness, normalisation
   gain, both manual gains, the resulting level, and whether it will clip.

Normalisation is measured over the **trimmed** region of a sound, since that
is what actually plays. Gain is linear only — there is no compression or
limiting.

## Why analysis is stored as blocks, not a number

Measuring loudness normally means decoding the whole file and reducing it to
one figure. That would be useless here, because normalisation has to react to
a trim handle moving, and re-decoding on every drag is not an option.

Instead, `AudioFile.loudness` (`src/lib/db.ts:23`) stores the sequence BS.1770
actually works from — a channel-weighted mean square for every 400 ms gating
block at a 100 ms hop (`blockMeanSquare`), plus a 4x-oversampled true peak per
100 ms hop (`hopTruePeak`). See `LoudnessAnalysis` in
`src/lib/audio/loudness/types.ts`.

Both of BS.1770's gates — the absolute gate and the relative gate — read only
that per-block sequence, never the raw samples. That means measuring any
sub-range of the file later is an exact slice of the stored arrays, not an
approximation: `measureRange(analysis, start, end)` in
`src/lib/audio/loudness/query.ts` is mathematically identical to running a
fresh analysis on that same span. This is why the live loudness readout while
dragging a trim handle in `WaveformTrimmer` (`src/components/WaveformTrimmer.tsx`)
can update on every pointer move — it's a slice over a few hundred cached
floats, never a re-decode.

A range under 400 ms (no complete block fits) uses the block with the
greatest overlap and is marked `estimated: true`. This matters more here than
in a typical loudness tool: a lot of soundboard content is sub-400 ms stabs
and stingers.

Storage cost is small: roughly 80 bytes per second of audio, about 4.8 KB per
minute, against audio blobs measured in tens of megabytes.

## The three gain stages

At playback, gain resolves in one function: `resolveGain` in
`src/lib/audio/loudness/gain.ts`. It is the single source of truth for level
arithmetic — both the audio trigger path (`src/lib/audio/controls.ts:380`)
and the loudness overview (`buildSoundRows` in
`src/lib/audio/loudness/overview.ts`) call it. There is deliberately no
second implementation: a table that computes gain its own way could disagree
with what you actually hear, which is worse than no table at all.

Three dB offsets sum before converting to a linear multiplier:

```
normDb    (derived from measured loudness, never stored)
+ soundGainDb  (per-sound manual gain, keyed by audio file ID)
+ padGainDb    (per-pad manual gain, applies on top of every sound on the pad)
= totalDb → linear = 10 ** (totalDb / 20)
```

That `linear` value is written straight to `PlayAudioParams.volume`
(`src/lib/audio/types.ts:122`) and multiplies the gain node on both playback
paths.

Normalisation itself is bounded by three separate limits, kept distinct on
purpose (`src/lib/audio/loudness/constants.ts`):

- `MAX_NORM_BOOST_DB` (24 dB) — caps what the app will ask for on its own.
- `MANUAL_GAIN_RANGE_DB` (−24 to +12 dB) — the range each gain knob offers.
- `MAX_TOTAL_GAIN_DB` (36 dB) — a rail on the summed gain, reachable only by
  stacking a large automatic boost with both manual knobs.

Collapsing these into one number was the first draft of the design and was
wrong: it let the reported level diverge from the played level. Every field
on `ResolvedGain` — `normDb`, `totalDb`, `finalLufs`, `predictedPeakDb` — is
derived from `totalDb`, the gain actually applied after any rail bites, never
from the gain that was requested. That is what keeps the overview table
honest when `gainClamped` or `boostCapped` fires.

The playback gain clamp used to cap at unity (`Math.min(1, volume)`), which
would have made normalisation unable to ever boost a quiet file. It is now
`Math.min(MAX_GAIN, volume)` (`clampPlaybackGain` in
`src/lib/audio/playback.ts`), where `MAX_GAIN` is the linear form of
`MAX_TOTAL_GAIN_DB` (~63.1).

### Peak limiting

A very loud file needs little or no normalisation gain, but a quiet, peaky
file (transients that spike near full scale despite a low integrated
loudness) can't always reach the target loudness without pushing its true
peak past −1 dBTP. When that happens, normalisation gain is reduced to
respect the ceiling instead of the target, and `resolveGain` sets
`peakLimited: true`. The UI surfaces this as an amber `⚠ peak limited` badge
rather than silently under-normalising — it's exactly the case where the
automatic answer can't win and manual gain is the intended remedy.

## The clip warning: what it covers and what it doesn't

`resolveGain` predicts whether a single sound will clip on its own:
`willClip` is true when the sound's true peak plus its total applied gain
(`predictedPeakDb`) exceeds 0 dBFS. This is exact, not a heuristic — it
reuses the same oversampled true-peak measurement normalisation uses, and it
is evaluated on `totalDb`, so pushing manual gain up can trigger it even when
normalisation alone would have been safe. That's intentional: you asked for
the extra gain, and the warning tells you the cost.

**What it does not cover: several pads playing at once.** Two individually
safe sounds can sum past full scale when they play together, and nothing in
this feature detects that — it's explicitly out of scope. The design's
intended follow-on is a real-time master clip indicator driven by an
`AnalyserNode` on the audio destination, watching the actual mixed output;
that has not been built. If you're stacking a lot of simultaneous pads at or
near 0 dB, headroom is on you for now.

## Backfill: analysis never blocks

Analysis requires a full decode, which is the expensive part, so it happens
in two ways and never on the trigger path:

- **On import**, the file is already being decoded, so it's analysed in the
  same pass (`analyseAndStore` in `src/lib/audio/loudness/pipeline.ts`).
- **Existing files** are swept in the background: on profile activation,
  `runBackfill` finds every file whose analysis is missing or was made with
  an older `LOUDNESS_ALGO_VERSION`, and analyses a few at a time on
  `requestIdleCallback` (falling back to a timer where that API doesn't
  exist).

Until a file is analysed, `normDb` resolves to 0 — it plays exactly as it did
before this feature existed. The overview table shows `unmeasured` rows
rather than guessing a number.

**Progress appears in profile settings.** `ProfileCard`
(`src/components/profiles/ProfileCard.tsx`) shows "Analysing 12/180…" for the
active profile's backfill, next to the normalisation enable toggle and target
LUFS slider, by subscribing to `subscribeToBackfillProgress`. It does not
currently appear inside the loudness overview modal.

`runBackfill` must have **exactly one caller** — currently
`ClientSideInitializer` (`src/components/ClientSideInitializer.tsx:105`), run
once per profile activation. A second concurrent caller takes a new
generation token and supersedes the first; the superseded run can still be
mid-flight and finish writing to the in-memory loudness cache _after_ the
surviving run already finished, leaving the cache repopulated from a stale
snapshot. Anything that wants to observe progress — a settings panel, the
overview modal — should call `subscribeToBackfillProgress` instead of
starting its own backfill. (This was a real bug during development: an
earlier version had `ProfileCard` starting a second backfill and it had to be
removed.)

## Where to find the controls

- **Per-sound gain** — a compact dB control in the sound list of the edit pad
  form (`EditPadForm`, `src/components/modals/EditPadForm.tsx`), for quick
  adjustment without leaving the form.
- **The trim editor** (`WaveformTrimmer`) has the full live readout: measured
  LUFS for the current trim range, normalisation gain, the resulting final
  loudness, and the peak-limited / clip warnings — all updating live while
  dragging either the trim handles or the gain slider.
- **Per-pad gain** — a single dB control in `EditPadForm`, applied on top of
  every sound's own gain.
- **Profile settings** (`ProfileCard`) — the enable toggle, the target LUFS
  slider, and backfill progress.
- **The loudness overview** — opened from the toolbar button in
  `src/components/buttons/LoudnessOverviewButton.tsx`, scoped to the active
  profile. Two tabs:
  - **Sounds** — one row per (pad, sound): Bank · Pad, Sound, Measured, Norm,
    Sound gain, Pad gain, Final, Δ target. Every column is sortable (click to
    sort, click again to reverse); default sort is worst-first. A "Problems
    only" checkbox keeps rows that clip, are peak-limited, hit the gain rail,
    or sit more than ±3 dB off target — the filter that actually gets used
    once a board has 200 rows. Gain cells are inline-editable. Rows with no
    measurement (silent, or not yet analysed) render `—` and always sort
    last, regardless of sort direction.
  - **Pads** — one row per pad, aggregating its sounds' final loudness (min,
    max, spread). This catches a pad whose round-robin variations disagree
    with _each other_, so its level jumps depending on which one fires.

## Sync, import and export

### Audio-file-ID remapping

`audioGainSettings` (`PadConfiguration.audioGainSettings`, `src/lib/db.ts:103`)
is a `Record<audioFileId, number>`, mirroring the existing
`audioTrimSettings` in shape. Audio file IDs are local, auto-incrementing
IndexedDB keys, so they get **remapped** every time a pad's settings cross a
device boundary — on import and on sync. There are two remapping functions in
`src/lib/importExport.ts`, and they intentionally behave differently:

- `remapPadSettingsOnImport` (drops unmapped keys) — used by import and by
  Google Drive sync (`src/lib/googleDrive/dataAccess.ts:341,345`). If an ID
  has no mapping here, the audio it refers to didn't come across, so the
  setting is dropped rather than left pointing at nothing.
- `remapPadSettingsOnMerge` (keeps unmapped keys) — used by server-sync
  merges (`src/lib/syncUtils.ts:559,563`). An unmapped ID here just means a
  file that doesn't have a local counterpart _yet_, so the setting is kept
  under its original ID to survive until something resolves it.

Both are called for `audioTrimSettings` and `audioGainSettings` alike at
every site. **Any future `Record<audioFileId, …>` field on a pad needs the
same treatment in all these places**, or it will silently attach to the
wrong sounds after an import or a sync — there is no error, just a gain (or
whatever the new field is) landing on a file it was never meant for.
`padGainDb` is a plain scalar and needs no remapping.

### Export

`LoudnessAnalysis` is included in the V2 export manifest
(`src/lib/importExport.ts`), with its two `Float32Array`s base64-encoded.
Analysis is accepted back on import only when its `algoVersion` matches the
current `LOUDNESS_ALGO_VERSION`; a stale one is dropped and the file is
queued for the idle backfill sweep instead.

### The Google Drive gap

**Google Drive sync does not carry loudness analysis.** The Drive data layer
(`src/lib/googleDrive/dataAccess.ts`) remaps `audioTrimSettings` and
`audioGainSettings`, the same as import, but it has no handling for the
`loudness` field at all. A profile pulled down through Drive sync arrives
without its analysis and gets re-analysed locally by the same backfill sweep
that handles a fresh install. That's graceful — the sound plays at 0 dB
normalisation in the meantime, then normalises once the sweep catches up —
but it is a real gap, not a hidden one: a Drive-synced device does real
decode-and-analyse work that a device receiving the same profile via export
or server-sync metadata would not have to.

## A known display race

Two gain edits landing within the same database round-trip (for example, two
quick drags in the loudness overview, or a drag racing an edit in
`EditPadForm`) are unordered, fire-and-forget writes against IndexedDB — each
read-modifies-writes the pad it saw at the time it started. The value that
ends up stored is whichever write actually lands last, so the data itself is
correct. What can briefly disagree is the **display**: a component holding
onto its own snapshot of the pad won't necessarily reflect the other write
until it's reopened or otherwise re-reads from the database. This has not
caused a reported bug, but it's a real property of the current write path
worth knowing about before debugging a "the number looks wrong" report.

## Testing

`analyse.ts` and `query.ts` are pure functions over `Float32Array` (no Web
Audio, no DOM), so they're unit-tested directly, including the compliance
anchor (a −23 dBFS 1 kHz sine must measure −23.0 ± 0.1 LUFS, per EBU Tech 3341) and the range-equivalence property that the whole trim-aware design
rests on. `resolveGain` is unit-tested for every rail and edge case. The
three ID-remapping sites each have a regression test. End-to-end coverage
lives in `e2e-tests/loudness.spec.ts` (chromium only, per this project's E2E
policy); because resolved gain isn't observable from the DOM, it's exposed
through `exposeE2EHook` (`src/lib/testHooks.ts`) as
`__impampLastResolvedGain`, set in `src/lib/audio/controls.ts` right before
each playback attempt.
