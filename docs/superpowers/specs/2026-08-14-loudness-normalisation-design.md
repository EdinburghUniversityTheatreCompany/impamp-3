# Loudness normalisation and gain control — design

**Date:** 2026-08-14
**Status:** Approved for planning

## Summary

Every sound on a board should play at a consistent level without the user
hand-tuning each one, and the user should still be able to override that level
per sound and per pad when the automatic answer is wrong.

Three things are added:

1. **Automatic loudness normalisation.** Every audio file is analysed once for
   ITU-R BS.1770-4 loudness. At playback, a gain is derived that brings the
   sound to a per-profile target (default −16 LUFS), clamped so it never
   exceeds a −1 dBTP ceiling.
2. **Manual gain, per sound and per pad.** Two independent dB offsets that
   multiply on top of normalisation, so adjusting one never destroys the other.
3. **A loudness overview.** A sortable, filterable table of every pad and
   sound showing measured loudness, normalisation gain, manual gains, the
   resulting final level, and whether the result will clip.

Normalisation is measured over the **trimmed** region of a sound, not the whole
file, because the trimmed region is what actually plays.

### Goals

- Consistent perceived level across a board with no manual work.
- Manual override that survives re-normalisation.
- Exact, live clip prediction before a sound is ever played.
- No re-decoding when a trim handle moves or the target changes.
- No change to stored audio bytes.

### Non-goals

- Dynamics processing (compression, limiting). Gain is linear only.
- Predicting clipping from _simultaneous_ sounds summing. See
  [Out of scope](#out-of-scope).
- Loudness matching across profiles.

## Background: what exists today

| Fact                                                                                                                   | Location                                                                                                                                          | Relevance                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PlayAudioParams.volume` is declared, wired into the gain node on both playback paths, and **never set by any caller** | `src/lib/audio/types.ts:118`, `src/lib/audio/playback.ts:53,255,358`                                                                              | The playback plumbing already exists and is unused                             |
| Gain is clamped to `[0, 1]`                                                                                            | `src/lib/audio/playback.ts:64`, `:374`                                                                                                            | Blocks boost; must be lifted                                                   |
| Fades ramp the track's existing gain node from `gain.value`                                                            | `src/lib/audio/playback.ts:651`                                                                                                                   | Fades already compose correctly with a non-unity base gain — no change needed  |
| `PadConfiguration.audioTrimSettings: Record<audioFileId, {trimStart, trimEnd}>`                                        | `src/lib/db.ts:65`                                                                                                                                | Exact structural precedent for per-sound settings                              |
| `AudioFile.hash` (SHA-256 of blob)                                                                                     | `src/lib/db.ts:12`                                                                                                                                | Loudness is content-derived, so it caches alongside dedup                      |
| `audioFileId` keys are **remapped** on import and sync                                                                 | `src/lib/importExport.ts:415`, `src/lib/googleDrive/dataAccess.ts:337`, `src/lib/syncUtils.ts:554`                                                | Any new `Record<audioFileId, …>` field must be remapped in all three           |
| `PadContent` is a `Pick<PadConfiguration, …>` used by pad swap                                                         | `src/lib/db.ts:1104`                                                                                                                              | Adding fields there is compiler-enforced at both construction sites            |
| Trigger args are hand-copied at ~10 call sites                                                                         | `useKeyboardListener.ts:93,130,621`, `useSearch.ts:171`, `SearchModal.tsx:96,160`, `usePadInteractions.ts:86,110,286,375`, `playbackStore.ts:211` | Optional fields mean a missed site fails **silently** on one trigger path only |

## Data model

### `AudioFile.loudness`

Measured once per file. Content-derived, so it is valid for the lifetime of the
blob.

```ts
export interface LoudnessAnalysis {
  /** Analysis algorithm version. Bump forces re-measurement. */
  algoVersion: number;
  /** Sample rate the analysis ran at (Hz). */
  sampleRate: number;
  /** Total decoded duration in seconds. */
  duration: number;
  /**
   * Channel-weighted mean square per 400 ms gating block, at a 100 ms hop.
   * Block j covers [j * 0.1, j * 0.1 + 0.4] seconds.
   * This is the `sum_i G_i * z_ij` term of BS.1770-4 — the only per-block
   * quantity either gate needs, which is what makes sub-range queries exact.
   */
  blockMeanSquare: Float32Array;
  /**
   * 4x-oversampled true peak (linear, not dB) per non-overlapping 100 ms hop.
   * Hop k covers [k * 0.1, (k + 1) * 0.1] seconds.
   */
  hopTruePeak: Float32Array;
}

export interface AudioFile {
  // …existing fields…
  loudness?: LoudnessAnalysis;
}
```

Storage cost: 10 blocks/s + 10 hops/s at 4 bytes each = **80 bytes per second**,
i.e. ~4.8 KB per minute of audio. A 30-minute board adds ~150 KB against audio
blobs measured in tens of megabytes.

Typed arrays are stored directly in IndexedDB (structured-clone handles them).

### `PadConfiguration` gain fields

```ts
export interface PadConfiguration {
  // …existing fields…
  /** Per-sound manual gain in dB. Absent or 0 means unity. */
  audioGainSettings?: Record<number, number>;
  /** Whole-pad manual gain in dB, applied on top of per-sound gain. */
  padGainDb?: number;
}
```

`audioGainSettings` deliberately mirrors `audioTrimSettings` in shape and
lifecycle so it can follow the same code paths everywhere.

### `Profile.normalisation`

```ts
export interface NormalisationSettings {
  enabled: boolean;
  /** Target integrated loudness in LUFS. */
  targetLufs: number;
}

export interface Profile {
  // …existing fields…
  normalisation?: NormalisationSettings;
}

export const DEFAULT_NORMALISATION: NormalisationSettings = {
  enabled: true,
  targetLufs: -16,
};
```

Absent means default, so no migration is needed for existing profiles. This
follows the `isDisabled` precedent (`src/lib/db.ts:72`).

### Constants

```ts
/** True-peak ceiling for normalisation gain, dBTP. */
export const PEAK_CEILING_DBTP = -1;
/**
 * Cap on automatic boost, dB. A very quietly recorded file that is not quite
 * silent enough to trip the absolute gate could otherwise ask for +39 dB.
 */
export const MAX_NORM_BOOST_DB = 24;
/** Manual gain range offered per knob in the UI, dB. */
export const MANUAL_GAIN_RANGE_DB = { min: -24, max: 12 };
/**
 * Safety rail on the summed gain, dB. Reachable only by stacking a large
 * automatic boost with both manual knobs; when it bites, `gainClamped` is set
 * so the UI reports the level that will actually play.
 */
export const MAX_TOTAL_GAIN_DB = 36;
/** Linear form of MAX_TOTAL_GAIN_DB. Replaces the current playback clamp of 1. */
export const MAX_GAIN = 10 ** (MAX_TOTAL_GAIN_DB / 20); // ~63.1
export const LOUDNESS_ALGO_VERSION = 1;
```

These three limits are distinct on purpose. `MAX_NORM_BOOST_DB` bounds what the
app does on its own; `MANUAL_GAIN_RANGE_DB` bounds each knob the user turns; and
`MAX_TOTAL_GAIN_DB` is a rail that should essentially never be hit. Collapsing
them into one number was the first draft of this design and it was wrong — it
let the reported level diverge from the played level.

### IndexedDB version

No bump required. No object stores or indexes change; only optional properties
are added to existing records.

## Measurement

New module `src/lib/audio/loudness/analyse.ts`. Pure functions over
`Float32Array[]` plus a sample rate — no Web Audio, no DOM — so it is directly
unit-testable.

### K-weighting

BS.1770-4 K-weighting is two cascaded biquads:

1. High-shelf: `f0 = 1681.974450955533 Hz`, `G = 3.999843853973347 dB`,
   `Q = 0.7071752369554196`
2. High-pass (RLB): `f0 = 38.13547087602444 Hz`, `Q = 0.5003270373238773`

Coefficients **must be derived from these parameters at the file's actual
sample rate** via the bilinear transform, not hardcoded at 48 kHz. Decoded
buffers arrive at the `AudioContext` rate, commonly 44.1 or 48 kHz, and
hardcoded 48 kHz coefficients measurably skew 44.1 kHz material.

### Block loudness

For each 400 ms block at a 100 ms hop:

```
w_j = sum over channels i of ( G_i * mean(y_ij^2) )
l_j = -0.691 + 10 * log10(w_j)          // block loudness, LUFS
```

Channel weights `G_i`: 1.0 for left, right and centre; 1.41 for surrounds; LFE
excluded. Mono and stereo are the realistic cases here, so both weights are 1.0.

Only `w_j` is stored. `l_j` is derived on demand.

### Integrated loudness over a block range

```
J_a = { j in range : l_j > -70 }                                  // absolute gate
gamma_r = -0.691 + 10 * log10( mean(w_j for j in J_a) ) - 10      // relative gate
J_r = { j in J_a : l_j > gamma_r }
integrated = -0.691 + 10 * log10( mean(w_j for j in J_r) )
```

Because both gates and the final mean read only `w_j`, computing this over a
slice of `blockMeanSquare` is **mathematically identical** to analysing that
region of audio directly. It is not an approximation.

### True peak

`hopTruePeak` is computed with 4x oversampling per BS.1770-4 Annex 2 (48-tap
polyphase interpolation). Sample peak alone under-reports inter-sample peaks by
up to ~3 dB, and under-reports worst on heavily limited masters — precisely the
material that ends up on a soundboard. Getting this wrong makes the clip
warning under-warn on exactly the files that need it.

### Degenerate cases

| Case                                                      | Behaviour                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Range shorter than 400 ms (no complete block)             | Use the `w_j` of the block with the greatest overlap; mark the result `estimated` |
| Range contains no block above the absolute gate (silence) | Report `null` loudness; normalisation gain is 0 dB                                |
| `w_j <= 0` for all blocks in range                        | Same as silence                                                                   |
| Decode failure                                            | No `loudness` written; the file plays at 0 dB normalisation                       |

Short-range handling matters more here than in a typical loudness tool: a large
share of soundboard content is sub-400 ms stabs and stingers.

## Range-queryable loudness

New module `src/lib/audio/loudness/query.ts`:

```ts
export interface RangeLoudness {
  /** Integrated loudness over the range, LUFS. null when silent/unmeasurable. */
  lufs: number | null;
  /** True peak over the range, dBTP. */
  truePeakDb: number;
  /** True when derived from a partial block (range < 400 ms). */
  estimated: boolean;
}

export function measureRange(
  analysis: LoudnessAnalysis,
  startSec: number,
  endSec: number,
): RangeLoudness;
```

Block `j` is included when its whole 400 ms window lies inside the range:
`j * 0.1 >= startSec` and `j * 0.1 + 0.4 <= endSec`.

Peak hops are included when they overlap the range **at all**. This can
over-report by up to 100 ms of audio at each edge — a transient just outside the
trim can inflate the figure. That asymmetry is deliberate: over-reporting peak
costs a little unused headroom, whereas under-reporting it produces audible
clipping and a clip warning that failed to fire.

This is what makes trim-aware normalisation cheap: dragging a trim handle
re-measures from a few hundred cached floats, with no decode.

## Gain resolution

New module `src/lib/audio/loudness/gain.ts`:

```ts
export interface ResolvedGain {
  /** Gain contributed by normalisation, dB. */
  normDb: number;
  /** Gain actually applied: normalisation plus both manual gains, dB. */
  totalDb: number;
  /** Linear multiplier handed to the gain node. */
  linear: number;
  /** Loudness the sound will actually play at, LUFS. null when unmeasurable. */
  finalLufs: number | null;
  /** Predicted output true peak after all gain, dBTP. */
  predictedPeakDb: number;
  /** Normalisation was reduced to respect the peak ceiling. */
  peakLimited: boolean;
  /** Normalisation boost was capped by MAX_NORM_BOOST_DB. */
  boostCapped: boolean;
  /** The summed gain hit MAX_TOTAL_GAIN_DB and was reduced. */
  gainClamped: boolean;
  /** predictedPeakDb exceeds 0 dBFS — this sound will clip on its own. */
  willClip: boolean;
  /** Loudness came from a partial block. */
  estimated: boolean;
  /** No analysis available yet; normDb is 0. */
  unmeasured: boolean;
}
```

```
rawNormDb  = targetLufs - lufs
normDb     = !enabled || lufs === null
           ? 0
           : min( rawNormDb,
                  PEAK_CEILING_DBTP - truePeakDb,
                  MAX_NORM_BOOST_DB )

rawTotalDb = normDb + soundGainDb + padGainDb
totalDb    = min(rawTotalDb, MAX_TOTAL_GAIN_DB)

linear          = 10 ** (totalDb / 20)
finalLufs       = lufs === null ? null : lufs + totalDb
predictedPeakDb = truePeakDb + totalDb

peakLimited = enabled && lufs !== null
              && rawNormDb > (PEAK_CEILING_DBTP - truePeakDb)
boostCapped = enabled && lufs !== null && rawNormDb > MAX_NORM_BOOST_DB
gainClamped = rawTotalDb > MAX_TOTAL_GAIN_DB
willClip    = predictedPeakDb > 0
```

Every reported figure is derived from `totalDb`, the gain that is actually
applied — not from the requested gain. This is what keeps the overview table
honest when a rail bites.

`normDb` is never negative-clamped: a too-loud file is attenuated, which is
always safe. `peakLimited` is surfaced in the UI because it is exactly the case
where the automatic answer cannot reach target and manual gain is the remedy.

Note that `willClip` is evaluated on `totalDb`, so manual gain can push a sound
into clipping even when normalisation alone would not have. That is intentional
— the user asked for the override, and the warning tells them the cost.

## Playback integration

### Warm cache

A module-level `Map<audioFileId, LoudnessAnalysis>` is populated when a profile
is activated, so gain resolution at trigger time is **synchronous**. Adding an
`await` to the trigger path would add jitter to a live-performance tool and is
not acceptable.

The cache is populated by cursor-iterating `audioFiles` for the active profile
and copying only the `loudness` field. The cursor must not retain `blob`
references. Invalidated on profile switch and when a measurement completes.

Memory cost matches the storage figure: ~150 KB for a 30-minute board.

### Trigger path

In `src/lib/audio/controls.ts`, next to the existing trim lookup at line 372:

```ts
const trimForFile = audioTrimSettings?.[audioFileId];
const analysis = getCachedLoudness(audioFileId);
const resolved = resolveGain({
  analysis,
  trimStart: trimForFile?.trimStart ?? 0,
  trimEnd: trimForFile?.trimEnd,
  soundGainDb: audioGainSettings?.[audioFileId] ?? 0,
  padGainDb: padGainDb ?? 0,
  normalisation: activeProfileNormalisation,
});
```

and `buildPlayParams()` gains `volume: resolved.linear`.

`normDb` is resolved _inside_ `controls.ts` from the warm cache and the active
profile, so neither the analysis nor the profile setting needs threading
through any call site. Only the two pad-level dB fields ride the existing
channel.

### Clamp lift

`src/lib/audio/playback.ts:64` and `:374` currently clamp to
`Math.min(1, volume)`. Both become `Math.min(MAX_GAIN, volume)`. Without this,
no quiet file can ever be brought up and normalisation silently does half its
job.

### Fades

No change. `fadeOutTrack` reads `gain.value` and ramps from it
(`playback.ts:651`), so a track sitting at 0.4 fades from 0.4. Verified before
writing this spec.

## The `PadPlaybackSettings` refactor

The ~10 trigger call sites listed in [Background](#background-what-exists-today)
each hand-copy `audioTrimSettings`, `playbackType` and `isDisabled` into trigger
args. All of these fields are **optional**, so adding two more and missing a
site produces no compiler error — it produces a pad that plays at the wrong
level _only_ when triggered from search, or _only_ from an armed cue. That is a
bad silent-failure class to add ten instances of.

Introduce:

```ts
export type PadPlaybackSettings = Pick<
  PadConfiguration,
  | "audioFileIds"
  | "audioTrimSettings"
  | "audioGainSettings"
  | "padGainDb"
  | "playbackType"
  | "isDisabled"
  | "name"
>;

export function extractPadPlaybackSettings(
  pad: Partial<PadConfiguration>,
): PadPlaybackSettings;
```

Migrate every call site onto it, so the gain fields arrive everywhere at once
and any future per-sound field is a one-line change. `PadContent`
(`src/lib/db.ts:1104`) is redefined in terms of it.

This is in scope for the same change. Adding the fields without it is the
higher-risk option, not the cheaper one.

## Backfill

Analysis is never blocking.

- **On import:** the file is already being decoded, so analyse in the same pass
  and write `loudness` with the record.
- **Existing files:** on profile activation, cursor-scan for records where
  `loudness` is absent or `algoVersion` is stale, and analyse them on
  `requestIdleCallback` a few at a time. Progress (`Analysing 12/180…`) is shown
  in profile settings and in the overview modal.
- **Until measured:** `normDb` is 0, so the sound plays exactly as it does
  today. Rows in the overview show `unmeasured` rather than a wrong number.

Analysis requires a full decode, which is the expensive part. Decoded buffers
already in the cache (`src/lib/audio/cache.ts`) are reused rather than
re-decoded.

## Sync, import and export

### The `audioFileId` remapping hazard

`audioGainSettings` is keyed by `audioFileId`, and those IDs are remapped in
three places. All three must handle the new field alongside `audioTrimSettings`:

| Site                                | Existing trim handling |
| ----------------------------------- | ---------------------- |
| `src/lib/importExport.ts`           | lines 415–439          |
| `src/lib/googleDrive/dataAccess.ts` | lines 337–351          |
| `src/lib/syncUtils.ts`              | lines 554–567          |

Missing one corrupts gain silently on import or sync — the gains land on the
wrong sounds. Each gets a regression test mirroring the existing trim tests.

`padGainDb` is a scalar and needs no remapping.

### Field-level sync

`audioGainSettings`, `padGainDb` and `Profile.normalisation` participate in the
existing `_fieldsModified` per-field merge. No new conflict semantics.

### Export

`LoudnessAnalysis` is included in the export manifest, with the typed arrays
base64-encoded. Exports are ZIP archives carrying the audio itself
(`src/lib/importExport.ts:86-88`), so a few KB of manifest per file is
negligible and it saves the importing device a full re-analysis pass.

On import, analysis is accepted only when `algoVersion` matches the current
constant; otherwise it is dropped and the file is queued for backfill.

## User interface

### Per-sound gain

Two places, because the two have different jobs:

- **`EditPadForm`** — a compact dB control per sound in the sound list, for
  quick adjustment without leaving the form.
- **`WaveformTrimmer`** — the full readout, since this component already decodes
  and draws the file. It shows measured LUFS for the trimmed region,
  normalisation gain, manual gain, resulting final loudness, and predicted peak
  with the clip warning. All of it updates **live** while dragging either a trim
  handle or the gain slider, since re-measuring a range is a slice over cached
  floats.

### Per-pad gain

A single dB control in `EditPadForm`, applying on top of every sound's own gain.

### Profile settings

Enable toggle, target LUFS, backfill progress, and a re-analyse action for the
case where a user suspects stale measurements.

### Loudness overview

A modal scoped to the active profile, with a bank filter and two tabs.

**Sounds tab** — one row per (pad, sound), the level that actually plays:

| Bank · Pad | Sound    | Measured (trimmed) | Norm   | Sound gain | Pad gain | Final     | Δ target |
| ---------- | -------- | ------------------ | ------ | ---------- | -------- | --------- | -------- |
| 2 · 14     | horn.wav | −27.3 LUFS         | +11.3  | 0.0        | 0.0      | **−16.0** | 0.0      |
| 1 · 03     | stab.wav | −30.1 _est_        | +0.9 ⚠ | +6.0       | 0.0      | **−23.2** | −7.2     |

**Pads tab** — one row per pad, aggregating its sounds: final loudness min, max
and spread. This catches the second failure mode — a pad whose round-robin
variations are inconsistent with _each other_, so its level jumps depending on
which sound fires.

Behaviour:

- **Every column sortable**, click to sort and click again to reverse. Default
  sort is Δ-target descending.
- **A "problems only" filter** showing rows that clip, are peak-limited, or sit
  more than ±3 dB off target. At 200 rows this is the control that gets used;
  sorting alone is tedious.
- **Gain cells are inline-editable**, so an outlier is fixed where it is found.
- Measured-untrimmed loudness on hover alongside the trimmed figure. A large gap
  between the two usually means the trim is wrong rather than the gain.
- Rows whose loudness is `null` (silent, or not yet analysed) render `—` for
  measured, final and Δ target rather than a misleading number, and sort last
  regardless of sort direction.

The table computes every row through the _same_ `resolveGain` function the
playback path uses. It must not have its own copy of the arithmetic — a table
that disagrees with what you hear is worse than no table.

### Colour marking

| State                      | Treatment                |
| -------------------------- | ------------------------ |
| Gain `0.0`                 | Muted, de-emphasised     |
| Boost `+6.0`               | Warm accent              |
| Cut `−3.0`                 | Cool accent              |
| Peak-limited normalisation | Amber, `⚠ peak limited`  |
| Predicted clipping         | Red, `⚠ clips by 1.4 dB` |
| Unmeasured                 | Muted, `analysing…`      |

Colour never carries meaning alone: the signed dB value is always rendered, and
both warning states carry text rather than only a swatch. This has to hold in
light and dark themes. Load the `dataviz` skill when implementing so the accent
pair is a coherent, contrast-checked set rather than ad hoc.

## Testing

### Unit — the anchor tests

`analyse.ts` and `query.ts` are pure functions over typed arrays, so they can be
tested properly rather than approximately.

- A −23 LUFS 1 kHz sine must measure −23.0 ± 0.1 LUFS. This is the compliance
  anchor; if it fails, nothing else matters.
- The same at 44.1 kHz and 48 kHz, confirming coefficients are derived per rate
  rather than hardcoded.
- Absolute gate: a signal with long silent passages must measure the same as the
  signal with those passages removed.
- Relative gate: a quiet tail below −10 LU of the mean must not drag the result
  down.
- **Range equivalence:** `measureRange(analysis, a, b)` must equal a fresh
  full analysis of that same region of audio, within float tolerance. This is
  the property the whole trim-aware design rests on.
- Sub-400 ms range returns `estimated: true` and a plausible value.
- Silence returns `lufs: null`, and `resolveGain` returns `normDb: 0`.
- True peak: a signal engineered to have inter-sample peaks above its sample
  peak must report the higher figure.

### Unit — gain resolution

- Peak ceiling clamps normalisation, and `peakLimited` is set.
- `willClip` is true exactly when `truePeak + totalDb > 0`.
- Manual gain pushing an otherwise-safe sound into clipping sets `willClip`.
- `enabled: false` and `unmeasured` both yield `normDb: 0`.
- `linear` never exceeds `MAX_GAIN`.

### Unit — persistence and sync

- `audioGainSettings` keys remap correctly on import, Drive sync and
  `syncUtils`, mirroring the existing trim tests. One test per site.
- Pad swap carries both new fields.
- Export round-trip preserves analysis; a stale `algoVersion` is dropped and
  re-queued.

### E2E (chromium only, per project CI policy)

- Assign a quiet file and a loud file to two pads, confirm the resolved gains
  differ in the documented direction.
- Adjust per-sound gain, confirm it persists and is reflected in the overview.
- Open the overview, sort by a column, apply the problems filter.

Resolved gain is not observable from the DOM, so `resolveGain`'s output must be
exposed through the existing `exposeE2EHook` mechanism
(`src/lib/testHooks.ts`) keyed by playback key. Without that hook the first
test above cannot be written, and asserting on a rendered number in the
overview would test the table rather than the audio path.

Firefox and WebKit stay on demand. Per `docs/cross-browser-e2e.md`, WebKit
cannot write a `Blob` to IndexedDB under Playwright on Linux, so no pad ever
gets a sound there — this feature cannot be meaningfully tested on it.

## Risks and edge cases

| Risk                                                              | Mitigation                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A missed `audioFileId` remap site corrupts gains silently         | Regression test per site; the three sites are enumerated above                                                               |
| A missed trigger call site applies gain on some paths only        | The `PadPlaybackSettings` refactor collapses 10 sites into 1                                                                 |
| Lifting the playback gain clamp lets a bad value blast the user   | Three separate limits (`MAX_NORM_BOOST_DB`, `MANUAL_GAIN_RANGE_DB`, `MAX_TOTAL_GAIN_DB`); clip warning shown before playback |
| A rail bites and the table reports a level that is not what plays | Every reported figure derives from `totalDb`, the applied gain, and `gainClamped` / `boostCapped` are surfaced               |
| Backfill decoding a large board janks the UI                      | Idle-callback scheduling, small batches, reuse of already-cached buffers                                                     |
| Cursor scan for backfill materialises every blob                  | Iterate with a cursor and copy only `loudness`; never retain `blob`                                                          |
| Hardcoded 48 kHz coefficients skew 44.1 kHz files                 | Coefficients derived from filter parameters at the actual rate; covered by a test at each rate                               |
| Sample-peak-only measurement under-warns about clipping           | 4x-oversampled true peak                                                                                                     |
| Table arithmetic drifts from playback arithmetic                  | Both call the same `resolveGain`; no second implementation permitted                                                         |

## Out of scope

- **Sum clipping.** Several pads fired together can clip even when each is
  individually safe. This is not statically predictable. The intended follow-on
  is a real-time master clip indicator driven by an `AnalyserNode` on the
  destination — deliberately deferred, not forgotten.
- **Limiting or compression** to force peak-limited files up to target. Linear
  gain only; the manual knob plus the `⚠ peak limited` badge is the answer.
- **Loudness matching across profiles.** The target is per profile.
- **Short-term / momentary loudness display.** Only integrated loudness is
  measured and shown.
