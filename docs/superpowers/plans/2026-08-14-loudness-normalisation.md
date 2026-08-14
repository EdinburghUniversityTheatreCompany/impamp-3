# Loudness Normalisation and Gain Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sound on a board plays at a consistent loudness automatically, with per-sound and per-pad manual gain overrides, exact clip prediction, and a sortable overview table of every level.

**Architecture:** Audio files are analysed once for ITU-R BS.1770-4 loudness, and the analysis is stored as a sequence of per-400 ms-block mean squares rather than a single number. Because both of BS.1770's gates read only that sequence, integrated loudness over any trimmed sub-range is an exact slice computation — so trim changes and target changes re-level with no re-decoding. At playback, a gain is derived from that analysis plus two manual dB offsets and written into `PlayAudioParams.volume`, a field that already exists and is already wired to the gain node but has never been set by any caller.

**Tech Stack:** TypeScript 6 (strict), Next.js 16, React 19, Zustand 5, idb 8 / IndexedDB, Web Audio API, Vitest 4 (node environment), Playwright 1.62, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-08-14-loudness-normalisation-design.md`

## Global Constraints

- **Node 24.19.0** everywhere. `node:sqlite` requires >= 22.13, which is the floor.
- **Vitest runs in the `node` environment** (`vitest.config.ts`). There is no Web Audio API, no `AudioContext`, and no DOM in unit tests. All loudness code must therefore be pure functions over `Float32Array[]` plus a sample rate. Where a test needs an `AudioBuffer`, fake it as a plain object cast through `as unknown as AudioBuffer` — follow `src/lib/audio/cache.test.ts:17-25`.
- **Unit tests live beside their source** as `src/**/*.test.ts` and are run with `npm test`.
- **E2E gates on chromium only.** Firefox and WebKit are on-demand and known-red for reasons outside the app. Playwright's Linux WebKit cannot write a `Blob` to IndexedDB, so no pad ever gets a sound there. See `docs/cross-browser-e2e.md`.
- **Path alias:** `@/*` maps to `src/*`.
- **Tailwind CSS 4**, no config file, opacity via the `/` notation. Every colour must be defined for both light and dark themes.
- **Prettier 3.9** formats on commit via an `hk` hook. Do not fight it.
- **Never import `src/lib/server/**` from client code** — it uses `node:sqlite`.
- **Always guard IndexedDB access** with `typeof window !== "undefined"`.
- **Colour never carries meaning alone.** Every gain value renders its signed dB number; every warning state renders text, not just a swatch.
- **Commit atomically.** Only stage files for the task at hand.

## Constant values (copied verbatim from the spec — use these exact numbers)

| Constant                | Value                                |
| ----------------------- | ------------------------------------ |
| `PEAK_CEILING_DBTP`     | `-1`                                 |
| `MAX_NORM_BOOST_DB`     | `24`                                 |
| `MANUAL_GAIN_RANGE_DB`  | `{ min: -24, max: 12 }`              |
| `MAX_TOTAL_GAIN_DB`     | `36`                                 |
| `MAX_GAIN`              | `10 ** (36 / 20)` ≈ 63.1             |
| `LOUDNESS_ALGO_VERSION` | `1`                                  |
| `DEFAULT_NORMALISATION` | `{ enabled: true, targetLufs: -16 }` |
| Gating block length     | 400 ms                               |
| Gating hop length       | 100 ms                               |
| Absolute gate           | −70 LUFS                             |
| Relative gate           | −10 LU below the gated mean          |
| Loudness offset         | `-0.691`                             |

---

## File Structure

**Phase 1 — analysis engine (pure, no app integration):**

| File                                   | Responsibility                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/audio/loudness/constants.ts`  | Every numeric constant above. No logic.                                                 |
| `src/lib/audio/loudness/kWeighting.ts` | Derive biquad coefficients at any sample rate; apply the two-stage cascade.             |
| `src/lib/audio/loudness/truePeak.ts`   | 4x-oversampled true peak per 100 ms hop.                                                |
| `src/lib/audio/loudness/analyse.ts`    | `analyseLoudness(channels, sampleRate)` → `LoudnessAnalysis`.                           |
| `src/lib/audio/loudness/query.ts`      | `measureRange(analysis, start, end)` → `RangeLoudness`.                                 |
| `src/lib/audio/loudness/gain.ts`       | `resolveGain(input)` → `ResolvedGain`. The single source of truth for level arithmetic. |
| `src/lib/audio/loudness/types.ts`      | `RangeLoudness`, `ResolvedGain`, `ResolveGainInput`.                                    |

**Phase 2 — persistence:** `src/lib/db.ts` (types + `PadPlaybackSettings`), `src/lib/importExport.ts`, `src/lib/googleDrive/dataAccess.ts`, `src/lib/syncUtils.ts`.

**Phase 3 — playback:** `src/lib/audio/loudness/cache.ts` (warm cache), `src/lib/audio/controls.ts`, `src/lib/audio/playback.ts`.

**Phase 4 — analysis pipeline:** `src/lib/audio/loudness/pipeline.ts` (analyse-on-import + idle backfill).

**Phase 5 — UI:** `src/components/modals/EditPadForm.tsx`, `src/components/WaveformTrimmer.tsx`, `src/components/profiles/ProfileCard.tsx`, `src/components/modals/LoudnessOverviewModalContent.tsx` (+ `loudnessOverview/` subcomponents), `src/components/modals/modalRegistry.ts`.

**Phase 6 — export, docs, E2E.**

`gain.ts` is deliberately the only place level arithmetic exists. The overview table and the playback path both call it. A second implementation anywhere is a bug — a table that disagrees with what you hear is worse than no table.

---

## Phase 1 — Analysis engine

### Task 1: Constants and K-weighting filter

**Files:**

- Create: `src/lib/audio/loudness/constants.ts`
- Create: `src/lib/audio/loudness/kWeighting.ts`
- Test: `src/lib/audio/loudness/kWeighting.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `kWeightingCoefficients(sampleRate: number): { stage1: Biquad; stage2: Biquad }`, `applyBiquad(input: Float32Array, c: Biquad): Float32Array`, `kWeight(channel: Float32Array, sampleRate: number): Float32Array`, and the constants table above. `Biquad` is `{ b0: number; b1: number; b2: number; a1: number; a2: number }`.

**Background the implementer needs:** BS.1770-4 K-weighting is two cascaded biquads — a high shelf and a high-pass ("RLB"). The standard publishes coefficients _only_ at 48 kHz. Decoded audio arrives at the `AudioContext` rate, commonly 44.1 kHz, and hardcoding the 48 kHz numbers measurably skews 44.1 kHz material. So derive them from the filter parameters via the bilinear transform at whatever rate the file actually is. The derivation below has been checked numerically: at 48 kHz it reproduces the published coefficients to five decimal places.

- [ ] **Step 1: Write the constants file**

```ts
/**
 * Audio Module - Loudness constants
 *
 * Every numeric constant for BS.1770-4 analysis and gain resolution.
 * No logic lives here so the values can be imported by tests without
 * pulling in the analysis engine.
 *
 * @module lib/audio/loudness/constants
 */

/** Gating block length in seconds (BS.1770-4). */
export const BLOCK_SECONDS = 0.4;
/** Gating hop length in seconds — 75% overlap. */
export const HOP_SECONDS = 0.1;
/** Loudness offset from BS.1770-4, compensating the K-filter gain at 1 kHz. */
export const LOUDNESS_OFFSET_DB = -0.691;
/** Absolute gate threshold, LUFS. */
export const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate, LU below the absolute-gated mean. */
export const RELATIVE_GATE_LU = -10;

/** True-peak ceiling that normalisation gain must respect, dBTP. */
export const PEAK_CEILING_DBTP = -1;
/**
 * Cap on automatic boost, dB. A very quietly recorded file that is not quite
 * silent enough to trip the absolute gate could otherwise ask for +39 dB.
 */
export const MAX_NORM_BOOST_DB = 24;
/** Manual gain range offered per knob in the UI, dB. */
export const MANUAL_GAIN_RANGE_DB = { min: -24, max: 12 } as const;
/**
 * Safety rail on the summed gain, dB. Reachable only by stacking a large
 * automatic boost with both manual knobs; when it bites, `gainClamped` is set
 * so the UI reports the level that will actually play.
 */
export const MAX_TOTAL_GAIN_DB = 36;
/** Linear form of MAX_TOTAL_GAIN_DB. Replaces the old playback clamp of 1. */
export const MAX_GAIN = 10 ** (MAX_TOTAL_GAIN_DB / 20);

/** Bump to force re-analysis of every stored file. */
export const LOUDNESS_ALGO_VERSION = 1;

/** Oversampling factor for true-peak detection. */
export const TRUE_PEAK_OVERSAMPLE = 4;
/** Taps per polyphase branch of the true-peak interpolator. */
export const TRUE_PEAK_TAPS_PER_PHASE = 12;
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/audio/loudness/kWeighting.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyBiquad, kWeight, kWeightingCoefficients } from "./kWeighting";

describe("kWeightingCoefficients", () => {
  // BS.1770-4 publishes coefficients only at 48 kHz. If our bilinear
  // derivation is right, it must reproduce them exactly at that rate.
  it("reproduces the published 48 kHz coefficients", () => {
    const { stage1, stage2 } = kWeightingCoefficients(48000);

    expect(stage1.b0).toBeCloseTo(1.53512485958697, 5);
    expect(stage1.b1).toBeCloseTo(-2.69169618940638, 5);
    expect(stage1.b2).toBeCloseTo(1.19839281085285, 5);
    expect(stage1.a1).toBeCloseTo(-1.69065929318241, 5);
    expect(stage1.a2).toBeCloseTo(0.73248077421585, 5);

    expect(stage2.b0).toBeCloseTo(1.0, 10);
    expect(stage2.b1).toBeCloseTo(-2.0, 10);
    expect(stage2.b2).toBeCloseTo(1.0, 10);
    expect(stage2.a1).toBeCloseTo(-1.99004745483398, 5);
    expect(stage2.a2).toBeCloseTo(0.99007225036621, 5);
  });

  it("produces different coefficients at 44.1 kHz", () => {
    const at48 = kWeightingCoefficients(48000);
    const at441 = kWeightingCoefficients(44100);
    // If these matched, the implementation hardcoded 48 kHz values and every
    // 44.1 kHz measurement would be wrong.
    expect(at441.stage1.b0).not.toBeCloseTo(at48.stage1.b0, 4);
  });
});

describe("applyBiquad", () => {
  it("passes a signal through a unity filter unchanged", () => {
    const input = Float32Array.from([1, -0.5, 0.25, 0]);
    const out = applyBiquad(input, { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
    expect(Array.from(out)).toEqual([1, -0.5, 0.25, 0]);
  });

  it("does not mutate its input", () => {
    const input = Float32Array.from([1, 1, 1, 1]);
    applyBiquad(input, { b0: 0.5, b1: 0, b2: 0, a1: 0, a2: 0 });
    expect(Array.from(input)).toEqual([1, 1, 1, 1]);
  });
});

describe("kWeight", () => {
  // The -0.691 offset in BS.1770 exists precisely to cancel the K-filter's
  // gain at 1 kHz, so that gain must be +0.691 dB. This pins the whole
  // filter cascade with a single number.
  it("has a gain of +0.691 dB at 1 kHz", () => {
    const sampleRate = 48000;
    const seconds = 2;
    const n = sampleRate * seconds;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }

    const out = kWeight(input, sampleRate);

    // Measure RMS over the second half only, so filter start-up transients
    // have decayed and do not bias the result.
    const from = Math.floor(n / 2);
    let inSum = 0;
    let outSum = 0;
    for (let i = from; i < n; i++) {
      inSum += input[i] * input[i];
      outSum += out[i] * out[i];
    }
    const gainDb = 10 * Math.log10(outSum / inSum);
    expect(gainDb).toBeCloseTo(0.691, 2);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/kWeighting.test.ts`
Expected: FAIL — `Failed to resolve import "./kWeighting"`.

- [ ] **Step 4: Implement the filter**

Create `src/lib/audio/loudness/kWeighting.ts`:

```ts
/**
 * Audio Module - K-weighting (ITU-R BS.1770-4)
 *
 * Two cascaded biquads: a high shelf and a high-pass ("RLB"). The standard
 * publishes coefficients only at 48 kHz, so they are derived here from the
 * filter parameters via the bilinear transform at whatever rate the file
 * actually is. Hardcoding the 48 kHz values measurably skews 44.1 kHz
 * material, which is a large share of real content.
 *
 * @module lib/audio/loudness/kWeighting
 */

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

// High-shelf stage parameters from BS.1770-4.
const SHELF_F0 = 1681.974450955533;
const SHELF_GAIN_DB = 3.999843853973347;
const SHELF_Q = 0.7071752369554196;
// The shelf's mid-band gain exponent, such that Vb = Vh ** this.
const SHELF_VB_EXPONENT = 0.4996667741545416;

// High-pass (RLB) stage parameters from BS.1770-4.
const HP_F0 = 38.13547087602444;
const HP_Q = 0.5003270373238773;

/**
 * Derives both K-weighting stages for a given sample rate.
 *
 * Verified: at 48000 this reproduces the coefficients published in
 * BS.1770-4 Tables 1 and 2 to five decimal places.
 */
export function kWeightingCoefficients(sampleRate: number): {
  stage1: Biquad;
  stage2: Biquad;
} {
  // Stage 1 - high shelf
  const k1 = Math.tan((Math.PI * SHELF_F0) / sampleRate);
  const vh = 10 ** (SHELF_GAIN_DB / 20);
  const vb = vh ** SHELF_VB_EXPONENT;
  const k1sq = k1 * k1;
  const denom1 = 1 + k1 / SHELF_Q + k1sq;

  const stage1: Biquad = {
    b0: (vh + (vb * k1) / SHELF_Q + k1sq) / denom1,
    b1: (2 * (k1sq - vh)) / denom1,
    b2: (vh - (vb * k1) / SHELF_Q + k1sq) / denom1,
    a1: (2 * (k1sq - 1)) / denom1,
    a2: (1 - k1 / SHELF_Q + k1sq) / denom1,
  };

  // Stage 2 - high pass. Numerator is fixed at (1, -2, 1).
  const k2 = Math.tan((Math.PI * HP_F0) / sampleRate);
  const k2sq = k2 * k2;
  const denom2 = 1 + k2 / HP_Q + k2sq;

  const stage2: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2sq - 1)) / denom2,
    a2: (1 - k2 / HP_Q + k2sq) / denom2,
  };

  return { stage1, stage2 };
}

/**
 * Direct Form I biquad. Returns a new array; the input is never mutated.
 */
export function applyBiquad(input: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  return out;
}

/**
 * Applies the full K-weighting cascade to one channel.
 */
export function kWeight(
  channel: Float32Array,
  sampleRate: number,
): Float32Array {
  const { stage1, stage2 } = kWeightingCoefficients(sampleRate);
  return applyBiquad(applyBiquad(channel, stage1), stage2);
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/kWeighting.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/loudness/constants.ts src/lib/audio/loudness/kWeighting.ts src/lib/audio/loudness/kWeighting.test.ts
git commit -m "feat(loudness): BS.1770-4 K-weighting derived per sample rate"
```

---

### Task 2: True peak detection

**Files:**

- Create: `src/lib/audio/loudness/truePeak.ts`
- Test: `src/lib/audio/loudness/truePeak.test.ts`

**Interfaces:**

- Consumes: `TRUE_PEAK_OVERSAMPLE`, `TRUE_PEAK_TAPS_PER_PHASE`, `HOP_SECONDS` from `./constants`.
- Produces: `computeHopTruePeak(channels: Float32Array[], sampleRate: number): Float32Array` — one linear (not dB) true-peak value per non-overlapping 100 ms hop, taken as the maximum across all channels.

**Background the implementer needs:** Sample peak is not output peak. Reconstructing the analog waveform between samples can exceed the highest sample by up to ~3 dB, and it does so worst on heavily limited masters — exactly the material that ends up on a soundboard. If we measure sample peak only, the clip warning under-warns on precisely the files that need it. BS.1770-4 Annex 2 specifies a 48-tap polyphase interpolator; we generate an equivalent windowed-sinc interpolator programmatically rather than transcribing a coefficient table, which is well inside tolerance for a clip warning and avoids a table of magic numbers nobody can verify.

- [ ] **Step 1: Write the failing test**

Create `src/lib/audio/loudness/truePeak.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeHopTruePeak } from "./truePeak";

const SAMPLE_RATE = 48000;

function sine(
  freq: number,
  seconds: number,
  amplitude = 1,
  phase = 0,
): Float32Array {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] =
      amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE + phase);
  }
  return out;
}

describe("computeHopTruePeak", () => {
  it("returns one value per 100 ms hop", () => {
    const peaks = computeHopTruePeak([sine(1000, 1)], SAMPLE_RATE);
    expect(peaks.length).toBe(10);
  });

  // A sine at fs/4 offset by 45 degrees lands every sample on +/-A/sqrt(2),
  // so its sample peak is 3.01 dB below its real peak of A. This is the
  // canonical case that sample-peak measurement gets wrong.
  it("finds an inter-sample peak that exceeds every sample", () => {
    const signal = sine(SAMPLE_RATE / 4, 1, 1, Math.PI / 4);

    let samplePeak = 0;
    for (const v of signal) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(samplePeak).toBeCloseTo(Math.SQRT1_2, 3);

    const peaks = computeHopTruePeak([signal], SAMPLE_RATE);
    const truePeak = Math.max(...Array.from(peaks));

    expect(truePeak).toBeGreaterThan(samplePeak * 1.3);
    expect(truePeak).toBeCloseTo(1.0, 1);
  });

  it("takes the maximum across channels", () => {
    const quiet = sine(1000, 0.5, 0.1);
    const loud = sine(1000, 0.5, 0.8);
    const peaks = computeHopTruePeak([quiet, loud], SAMPLE_RATE);
    expect(Math.max(...Array.from(peaks))).toBeGreaterThan(0.7);
  });

  it("reports zero for silence", () => {
    const peaks = computeHopTruePeak(
      [new Float32Array(SAMPLE_RATE)],
      SAMPLE_RATE,
    );
    expect(Math.max(...Array.from(peaks))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/truePeak.test.ts`
Expected: FAIL — `Failed to resolve import "./truePeak"`.

- [ ] **Step 3: Implement true peak**

Create `src/lib/audio/loudness/truePeak.ts`:

```ts
/**
 * Audio Module - True peak (ITU-R BS.1770-4 Annex 2)
 *
 * Sample peak under-reports real output peak by up to ~3 dB, and it
 * under-reports worst on heavily limited material — which is most of what
 * ends up on a soundboard. Measuring sample peak alone would make the clip
 * warning miss exactly the files it exists for.
 *
 * The signal is upsampled 4x with a windowed-sinc polyphase interpolator and
 * the peak is taken over the upsampled result.
 *
 * @module lib/audio/loudness/truePeak
 */

import {
  HOP_SECONDS,
  TRUE_PEAK_OVERSAMPLE,
  TRUE_PEAK_TAPS_PER_PHASE,
} from "./constants";

/**
 * Builds polyphase branches of a windowed-sinc low-pass interpolator.
 * Branch p reconstructs the sample at fractional offset p / oversample.
 */
function buildPolyphase(
  oversample: number,
  tapsPerPhase: number,
): Float32Array[] {
  const branches: Float32Array[] = [];
  const half = tapsPerPhase / 2;

  for (let p = 0; p < oversample; p++) {
    const taps = new Float32Array(tapsPerPhase);
    const frac = p / oversample;
    let sum = 0;

    for (let t = 0; t < tapsPerPhase; t++) {
      // Distance in input samples from this tap to the point being rebuilt.
      const x = t - half + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman window over the tap span, suppressing truncation ripple.
      const w = (t + 0.5) / tapsPerPhase;
      const window =
        0.42 -
        0.5 * Math.cos(2 * Math.PI * w) +
        0.08 * Math.cos(4 * Math.PI * w);
      const v = sinc * window;
      taps[t] = v;
      sum += v;
    }

    // Normalise so a DC input reconstructs at unity rather than drifting.
    if (sum !== 0) {
      for (let t = 0; t < tapsPerPhase; t++) taps[t] /= sum;
    }
    branches.push(taps);
  }

  return branches;
}

const POLYPHASE = buildPolyphase(
  TRUE_PEAK_OVERSAMPLE,
  TRUE_PEAK_TAPS_PER_PHASE,
);

/**
 * Computes the true peak of each non-overlapping 100 ms hop, as a linear
 * amplitude, maximised across all channels.
 *
 * Hop k covers [k * 0.1, (k + 1) * 0.1) seconds.
 */
export function computeHopTruePeak(
  channels: Float32Array[],
  sampleRate: number,
): Float32Array {
  const length = channels[0]?.length ?? 0;
  const hopSamples = Math.max(1, Math.round(HOP_SECONDS * sampleRate));
  const hopCount = Math.ceil(length / hopSamples);
  const peaks = new Float32Array(hopCount);

  const half = TRUE_PEAK_TAPS_PER_PHASE / 2;

  for (const channel of channels) {
    for (let hop = 0; hop < hopCount; hop++) {
      const start = hop * hopSamples;
      const end = Math.min(start + hopSamples, length);
      let peak = peaks[hop];

      for (let i = start; i < end; i++) {
        // The raw sample is itself a candidate — phase 0 of the interpolator.
        const raw = Math.abs(channel[i]);
        if (raw > peak) peak = raw;

        for (let p = 1; p < TRUE_PEAK_OVERSAMPLE; p++) {
          const taps = POLYPHASE[p];
          let acc = 0;
          for (let t = 0; t < TRUE_PEAK_TAPS_PER_PHASE; t++) {
            const idx = i - half + 1 + t;
            // Treat out-of-range as silence rather than wrapping.
            if (idx >= 0 && idx < length) acc += taps[t] * channel[idx];
          }
          const mag = Math.abs(acc);
          if (mag > peak) peak = mag;
        }
      }

      peaks[hop] = peak;
    }
  }

  return peaks;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/truePeak.test.ts`
Expected: PASS, 4 tests.

If the inter-sample test fails marginally (true peak below `samplePeak * 1.3`), the interpolator is under-resolving. Raise `TRUE_PEAK_TAPS_PER_PHASE` to 16 in `constants.ts` and re-run. Do not weaken the assertion — it is testing the one property this module exists to provide.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio/loudness/truePeak.ts src/lib/audio/loudness/truePeak.test.ts
git commit -m "feat(loudness): 4x-oversampled true peak per 100ms hop"
```

---

### Task 3: Block analysis

**Files:**

- Create: `src/lib/audio/loudness/analyse.ts`
- Modify: `src/lib/db.ts` (add the `LoudnessAnalysis` interface and the `loudness` field only — no other changes)
- Test: `src/lib/audio/loudness/analyse.test.ts`

**Interfaces:**

- Consumes: `kWeight` from `./kWeighting`, `computeHopTruePeak` from `./truePeak`, constants.
- Produces: `analyseLoudness(channels: Float32Array[], sampleRate: number): LoudnessAnalysis` and `analyseAudioBuffer(buffer: AudioBuffer): LoudnessAnalysis`. `LoudnessAnalysis` is exported from `@/lib/db`.

**Background the implementer needs:** For each 400 ms block at a 100 ms hop, BS.1770 reduces the audio to a single number `w_j = sum over channels of (G_i * mean(y^2))`, where `y` is the K-weighted signal. Block loudness is `-0.691 + 10*log10(w_j)`. Both gates and the final average read _only_ the `w_j` sequence — so storing `w_j` and nothing else is enough to recompute loudness over any sub-range later. That property is the whole reason this design does not need to re-decode when a trim handle moves. Channel weights `G_i` are 1.0 for left, right and centre and 1.41 for surrounds; mono and stereo are the realistic cases, so both are 1.0.

- [ ] **Step 1: Add the persisted type to `src/lib/db.ts`**

Insert directly after the `AudioFile` interface (currently ending at line 15):

```ts
/**
 * BS.1770-4 loudness analysis of one audio file.
 *
 * Stores per-block mean squares rather than a single loudness figure, because
 * both of BS.1770's gates read only that sequence. Integrated loudness over
 * any sub-range is therefore an exact slice computation, which is what lets a
 * trimmed region be normalised without re-decoding the file.
 *
 * Costs ~80 bytes per second of audio (~4.8 KB per minute).
 */
export interface LoudnessAnalysis {
  /** Analysis algorithm version. A bump forces re-measurement. */
  algoVersion: number;
  /** Sample rate the analysis ran at, Hz. */
  sampleRate: number;
  /** Total decoded duration, seconds. */
  duration: number;
  /**
   * Channel-weighted mean square per 400 ms gating block at a 100 ms hop.
   * Block j covers [j * 0.1, j * 0.1 + 0.4] seconds.
   */
  blockMeanSquare: Float32Array;
  /**
   * 4x-oversampled true peak (linear amplitude) per non-overlapping 100 ms
   * hop. Hop k covers [k * 0.1, (k + 1) * 0.1) seconds.
   */
  hopTruePeak: Float32Array;
}
```

Then add the field to `AudioFile` (currently `src/lib/db.ts:7-15`):

```ts
export interface AudioFile {
  id?: number;
  blob: Blob;
  name: string;
  type: string;
  hash?: string; // SHA-256 hex digest of blob content
  createdAt: Date;
  driveFileIds?: Record<number, string>; // profileId → Google Drive file ID
  /** BS.1770-4 analysis. Absent until the file has been analysed. */
  loudness?: LoudnessAnalysis;
}
```

No IndexedDB version bump: no object store or index changes, only an optional property.

- [ ] **Step 2: Write the failing test**

Create `src/lib/audio/loudness/analyse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LOUDNESS_ALGO_VERSION, LOUDNESS_OFFSET_DB } from "./constants";
import { analyseLoudness } from "./analyse";

const SAMPLE_RATE = 48000;

function sine(freq: number, seconds: number, dbfs: number): Float32Array {
  const amplitude = 10 ** (dbfs / 20);
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

/** Ungated mean of block loudness — enough to check the constant-signal case. */
function meanBlockLufs(blockMeanSquare: Float32Array): number {
  let sum = 0;
  for (const w of blockMeanSquare) sum += w;
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(sum / blockMeanSquare.length);
}

describe("analyseLoudness", () => {
  it("produces one block per 100 ms hop, less the block length", () => {
    const result = analyseLoudness([sine(1000, 2, -23)], SAMPLE_RATE);
    // 2s of audio, 400 ms blocks at a 100 ms hop => 17 complete blocks.
    expect(result.blockMeanSquare.length).toBe(17);
    expect(result.hopTruePeak.length).toBe(20);
  });

  // EBU Tech 3341 case 1. A stereo 1 kHz sine at -23 dBFS in both channels
  // must read -23.0 LUFS. This single number pins the filter, the -0.691
  // offset and the channel summing all at once.
  it("measures a stereo -23 dBFS 1 kHz sine as -23 LUFS", () => {
    const left = sine(1000, 5, -23);
    const right = sine(1000, 5, -23);
    const result = analyseLoudness([left, right], SAMPLE_RATE);
    expect(meanBlockLufs(result.blockMeanSquare)).toBeCloseTo(-23.0, 1);
  });

  // Channels are summed, not averaged. The same signal in one channel only
  // must therefore read 3.01 dB lower, not the same.
  it("sums channels rather than averaging them", () => {
    const mono = analyseLoudness([sine(1000, 5, -23)], SAMPLE_RATE);
    expect(meanBlockLufs(mono.blockMeanSquare)).toBeCloseTo(-26.01, 1);
  });

  it("measures the same LUFS at 44.1 kHz as at 48 kHz", () => {
    const n = Math.floor(44100 * 5);
    const amplitude = 10 ** (-23 / 20);
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ch[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    }
    const result = analyseLoudness([ch, ch], 44100);
    expect(meanBlockLufs(result.blockMeanSquare)).toBeCloseTo(-23.0, 1);
  });

  it("records metadata", () => {
    const result = analyseLoudness([sine(1000, 1, -23)], SAMPLE_RATE);
    expect(result.algoVersion).toBe(LOUDNESS_ALGO_VERSION);
    expect(result.sampleRate).toBe(SAMPLE_RATE);
    expect(result.duration).toBeCloseTo(1, 2);
  });

  it("returns no blocks for audio shorter than one block", () => {
    const result = analyseLoudness([sine(1000, 0.2, -23)], SAMPLE_RATE);
    expect(result.blockMeanSquare.length).toBe(0);
    expect(result.hopTruePeak.length).toBe(2);
  });

  it("handles an empty channel list without throwing", () => {
    const result = analyseLoudness([], SAMPLE_RATE);
    expect(result.blockMeanSquare.length).toBe(0);
    expect(result.duration).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/analyse.test.ts`
Expected: FAIL — `Failed to resolve import "./analyse"`.

- [ ] **Step 4: Implement the analyser**

Create `src/lib/audio/loudness/analyse.ts`:

```ts
/**
 * Audio Module - Loudness analysis (ITU-R BS.1770-4)
 *
 * Reduces audio to the per-block mean squares that BS.1770's gating operates
 * on, plus per-hop true peak. Deliberately does not compute a single
 * integrated figure: keeping the block sequence is what allows any trimmed
 * sub-range to be measured later without re-decoding.
 *
 * Pure functions over Float32Array — no Web Audio, so this runs in Vitest's
 * node environment.
 *
 * @module lib/audio/loudness/analyse
 */

import type { LoudnessAnalysis } from "@/lib/db";
import { BLOCK_SECONDS, HOP_SECONDS, LOUDNESS_ALGO_VERSION } from "./constants";
import { kWeight } from "./kWeighting";
import { computeHopTruePeak } from "./truePeak";

/**
 * BS.1770-4 channel weights. Left, right and centre count at unity; surrounds
 * at 1.41. Mono and stereo are the realistic cases here, so in practice every
 * weight is 1.0.
 */
function channelWeight(index: number, channelCount: number): number {
  if (channelCount <= 2) return 1;
  return index >= 3 ? 1.41 : 1;
}

/**
 * Analyses decoded audio into per-block mean squares and per-hop true peaks.
 */
export function analyseLoudness(
  channels: Float32Array[],
  sampleRate: number,
): LoudnessAnalysis {
  const length = channels[0]?.length ?? 0;
  const duration = length / sampleRate;

  if (length === 0) {
    return {
      algoVersion: LOUDNESS_ALGO_VERSION,
      sampleRate,
      duration: 0,
      blockMeanSquare: new Float32Array(0),
      hopTruePeak: new Float32Array(0),
    };
  }

  const blockSamples = Math.round(BLOCK_SECONDS * sampleRate);
  const hopSamples = Math.round(HOP_SECONDS * sampleRate);
  const blockCount =
    length < blockSamples
      ? 0
      : Math.floor((length - blockSamples) / hopSamples) + 1;

  const weighted = channels.map((c) => kWeight(c, sampleRate));
  const blockMeanSquare = new Float32Array(blockCount);

  for (let j = 0; j < blockCount; j++) {
    const start = j * hopSamples;
    const end = start + blockSamples;
    let w = 0;

    for (let ch = 0; ch < weighted.length; ch++) {
      const data = weighted[ch];
      let sumSquares = 0;
      for (let i = start; i < end; i++) {
        sumSquares += data[i] * data[i];
      }
      w += channelWeight(ch, weighted.length) * (sumSquares / blockSamples);
    }

    blockMeanSquare[j] = w;
  }

  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate,
    duration,
    blockMeanSquare,
    // True peak is measured on the unweighted signal — K-weighting is for
    // loudness perception, not for what the converter has to reproduce.
    hopTruePeak: computeHopTruePeak(channels, sampleRate),
  };
}

/**
 * Convenience wrapper for a decoded AudioBuffer. Kept separate so
 * analyseLoudness itself stays testable without Web Audio.
 */
export function analyseAudioBuffer(buffer: AudioBuffer): LoudnessAnalysis {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }
  return analyseLoudness(channels, buffer.sampleRate);
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/analyse.test.ts`
Expected: PASS, 7 tests.

The −23 LUFS assertion is the anchor for this entire feature. If it fails, stop and fix it before continuing — every later task builds on it being right.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/loudness/analyse.ts src/lib/audio/loudness/analyse.test.ts src/lib/db.ts
git commit -m "feat(loudness): BS.1770-4 block analysis with EBU R128 compliance test"
```

---

### Task 4: Range queries

**Files:**

- Create: `src/lib/audio/loudness/types.ts`
- Create: `src/lib/audio/loudness/query.ts`
- Test: `src/lib/audio/loudness/query.test.ts`

**Interfaces:**

- Consumes: `LoudnessAnalysis` from `@/lib/db`, constants.
- Produces: `RangeLoudness` (in `types.ts`) and `measureRange(analysis, startSec, endSec): RangeLoudness`.

**Background the implementer needs:** This is the task that justifies the storage design, so it carries the most important test in the plan: measuring a slice of a stored analysis must equal a fresh full analysis of that same region of audio. If that equivalence does not hold, trim-aware normalisation is not exact and the whole approach needs revisiting.

Note the deliberate asymmetry between blocks and peaks. A block is included only when its whole 400 ms window lies inside the range. A peak hop is included when it overlaps the range _at all_. Over-reporting peak costs a little unused headroom; under-reporting it produces audible clipping and a warning that failed to fire.

- [ ] **Step 1: Write the types file**

Create `src/lib/audio/loudness/types.ts`:

```ts
/**
 * Audio Module - Loudness types
 *
 * @module lib/audio/loudness/types
 */

/** Loudness and peak over one region of a file. */
export interface RangeLoudness {
  /** Integrated loudness over the range, LUFS. null when silent or unmeasurable. */
  lufs: number | null;
  /** True peak over the range, dBTP. -Infinity for digital silence. */
  truePeakDb: number;
  /** True when derived from a partial block (range shorter than 400 ms). */
  estimated: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/audio/loudness/query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyseLoudness } from "./analyse";
import { measureRange } from "./query";

const SAMPLE_RATE = 48000;

function sine(freq: number, seconds: number, dbfs: number): Float32Array {
  const amplitude = 10 ** (dbfs / 20);
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("measureRange", () => {
  it("measures a constant signal at its true level", () => {
    const analysis = analyseLoudness(
      [sine(1000, 5, -23), sine(1000, 5, -23)],
      SAMPLE_RATE,
    );
    const result = measureRange(analysis, 0, 5);
    expect(result.lufs).toBeCloseTo(-23.0, 1);
    expect(result.estimated).toBe(false);
  });

  // The property the entire storage design rests on: a slice of a stored
  // analysis must equal a fresh analysis of that region of audio.
  it("matches a fresh analysis of the same region", () => {
    const quiet = sine(1000, 4, -35);
    const loud = sine(1000, 4, -15);
    const full = concat(quiet, loud);

    const sliced = measureRange(
      analyseLoudness([full, full], SAMPLE_RATE),
      4,
      8,
    );
    const fresh = measureRange(
      analyseLoudness([loud, loud], SAMPLE_RATE),
      0,
      4,
    );

    expect(sliced.lufs).not.toBeNull();
    expect(sliced.lufs as number).toBeCloseTo(fresh.lufs as number, 1);
  });

  it("gives a different answer for a trimmed range than the whole file", () => {
    const full = concat(sine(1000, 4, -35), sine(1000, 4, -15));
    const analysis = analyseLoudness([full, full], SAMPLE_RATE);

    const whole = measureRange(analysis, 0, 8).lufs as number;
    const loudHalf = measureRange(analysis, 4, 8).lufs as number;

    expect(loudHalf).toBeGreaterThan(whole + 3);
  });

  // The absolute gate exists so silence does not drag the figure down.
  it("ignores digital silence via the absolute gate", () => {
    const tone = sine(1000, 3, -23);
    const silence = new Float32Array(SAMPLE_RATE * 3);
    const withSilence = concat(tone, silence);

    const toneOnly = measureRange(
      analyseLoudness([tone, tone], SAMPLE_RATE),
      0,
      3,
    ).lufs as number;
    const padded = measureRange(
      analyseLoudness([withSilence, withSilence], SAMPLE_RATE),
      0,
      6,
    ).lufs as number;

    expect(padded).toBeCloseTo(toneOnly, 1);
  });

  it("flags a sub-400 ms range as estimated but still returns a value", () => {
    const analysis = analyseLoudness(
      [sine(1000, 5, -23), sine(1000, 5, -23)],
      SAMPLE_RATE,
    );
    const result = measureRange(analysis, 1.0, 1.2);
    expect(result.estimated).toBe(true);
    expect(result.lufs).toBeCloseTo(-23.0, 1);
  });

  it("returns null loudness for silence", () => {
    const analysis = analyseLoudness(
      [new Float32Array(SAMPLE_RATE * 3)],
      SAMPLE_RATE,
    );
    const result = measureRange(analysis, 0, 3);
    expect(result.lufs).toBeNull();
  });

  it("reports true peak in dBTP", () => {
    const analysis = analyseLoudness([sine(1000, 2, -6)], SAMPLE_RATE);
    expect(measureRange(analysis, 0, 2).truePeakDb).toBeCloseTo(-6, 0);
  });

  it("clamps an out-of-range request to the analysed duration", () => {
    const analysis = analyseLoudness(
      [sine(1000, 2, -23), sine(1000, 2, -23)],
      SAMPLE_RATE,
    );
    const result = measureRange(analysis, -5, 99);
    expect(result.lufs).toBeCloseTo(-23.0, 1);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/query.test.ts`
Expected: FAIL — `Failed to resolve import "./query"`.

- [ ] **Step 4: Implement range queries**

Create `src/lib/audio/loudness/query.ts`:

```ts
/**
 * Audio Module - Loudness range queries
 *
 * Recomputes BS.1770 gated loudness over an arbitrary sub-range from a stored
 * analysis. Because both gates read only the per-block mean squares, this is
 * mathematically identical to analysing that region directly — not an
 * approximation — which is what lets a trim handle move without a re-decode.
 *
 * @module lib/audio/loudness/query
 */

import type { LoudnessAnalysis } from "@/lib/db";
import {
  ABSOLUTE_GATE_LUFS,
  BLOCK_SECONDS,
  HOP_SECONDS,
  LOUDNESS_OFFSET_DB,
  RELATIVE_GATE_LU,
} from "./constants";
import type { RangeLoudness } from "./types";

function blockLufs(w: number): number {
  return w > 0 ? LOUDNESS_OFFSET_DB + 10 * Math.log10(w) : -Infinity;
}

function meanOf(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Applies BS.1770's two gates to a set of block mean squares. */
function gatedLoudness(blocks: number[]): number | null {
  const absolutePassed = blocks.filter(
    (w) => blockLufs(w) > ABSOLUTE_GATE_LUFS,
  );
  if (absolutePassed.length === 0) return null;

  const relativeThreshold =
    blockLufs(meanOf(absolutePassed)) + RELATIVE_GATE_LU;

  const relativePassed = absolutePassed.filter(
    (w) => blockLufs(w) > relativeThreshold,
  );
  if (relativePassed.length === 0) return null;

  const result = blockLufs(meanOf(relativePassed));
  return Number.isFinite(result) ? result : null;
}

/**
 * Measures integrated loudness and true peak over [startSec, endSec].
 *
 * Blocks are included only when their whole 400 ms window lies inside the
 * range. Peak hops are included when they overlap the range at all — peak
 * must never be under-reported, since a missed peak is a clip warning that
 * failed to fire, whereas an over-reported one costs only a little headroom.
 */
export function measureRange(
  analysis: LoudnessAnalysis,
  startSec: number,
  endSec: number,
): RangeLoudness {
  const duration = analysis.duration;
  const start = Math.max(0, Math.min(startSec, duration));
  const end = Math.max(start, Math.min(endSec, duration));

  // --- Peak: every hop that overlaps the range at all ---
  let peakLinear = 0;
  const hopCount = analysis.hopTruePeak.length;
  const firstHop = Math.max(0, Math.floor(start / HOP_SECONDS));
  const lastHop = Math.min(hopCount - 1, Math.ceil(end / HOP_SECONDS) - 1);
  for (let k = firstHop; k <= lastHop; k++) {
    const v = analysis.hopTruePeak[k];
    if (v > peakLinear) peakLinear = v;
  }
  const truePeakDb = peakLinear > 0 ? 20 * Math.log10(peakLinear) : -Infinity;

  // --- Loudness: blocks fully inside the range ---
  const fullyInside: number[] = [];
  for (let j = 0; j < analysis.blockMeanSquare.length; j++) {
    const blockStart = j * HOP_SECONDS;
    if (blockStart >= start && blockStart + BLOCK_SECONDS <= end) {
      fullyInside.push(analysis.blockMeanSquare[j]);
    }
  }

  if (fullyInside.length > 0) {
    return {
      lufs: gatedLoudness(fullyInside),
      truePeakDb,
      estimated: false,
    };
  }

  // --- Fallback: range shorter than one gating block ---
  // A large share of soundboard content is sub-400 ms stabs, so this path is
  // routine rather than exotic. Use the block that overlaps the range most.
  let bestIndex = -1;
  let bestOverlap = 0;
  for (let j = 0; j < analysis.blockMeanSquare.length; j++) {
    const blockStart = j * HOP_SECONDS;
    const blockEnd = blockStart + BLOCK_SECONDS;
    const overlap = Math.min(end, blockEnd) - Math.max(start, blockStart);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = j;
    }
  }

  if (bestIndex === -1) {
    return { lufs: null, truePeakDb, estimated: true };
  }

  const w = analysis.blockMeanSquare[bestIndex];
  const lufs = blockLufs(w);

  return {
    lufs: Number.isFinite(lufs) && lufs > ABSOLUTE_GATE_LUFS ? lufs : null,
    truePeakDb,
    estimated: true,
  };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/query.test.ts`
Expected: PASS, 8 tests. The "matches a fresh analysis of the same region" test is the one that matters most; if it fails, do not proceed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/loudness/types.ts src/lib/audio/loudness/query.ts src/lib/audio/loudness/query.test.ts
git commit -m "feat(loudness): exact gated loudness over arbitrary sub-ranges"
```

---

### Task 5: Gain resolution

**Files:**

- Modify: `src/lib/audio/loudness/types.ts`
- Create: `src/lib/audio/loudness/gain.ts`
- Test: `src/lib/audio/loudness/gain.test.ts`

**Interfaces:**

- Consumes: `measureRange`, `RangeLoudness`, constants, `LoudnessAnalysis`, `NormalisationSettings` (defined here, re-exported from `@/lib/db` in Task 6).
- Produces: `ResolvedGain`, `ResolveGainInput`, `resolveGain(input: ResolveGainInput): ResolvedGain`.

**Background the implementer needs:** This function is the single source of truth for level arithmetic. Playback calls it and so does the overview table; a second implementation anywhere is a bug. Every reported figure must derive from `totalDb` — the gain actually applied after the rails — not from the gain that was requested. That is what keeps the table honest when a rail bites.

There are three separate limits and they are not interchangeable: `MAX_NORM_BOOST_DB` bounds what the app does on its own, `MANUAL_GAIN_RANGE_DB` bounds each knob the user turns, and `MAX_TOTAL_GAIN_DB` is a rail that should essentially never be reached.

- [ ] **Step 1: Add the gain types to `src/lib/audio/loudness/types.ts`**

Append:

```ts
/** Per-profile normalisation configuration. */
export interface NormalisationSettings {
  enabled: boolean;
  /** Target integrated loudness, LUFS. */
  targetLufs: number;
}

export const DEFAULT_NORMALISATION: NormalisationSettings = {
  enabled: true,
  targetLufs: -16,
};

export interface ResolveGainInput {
  /** Absent when the file has not been analysed yet. */
  analysis: import("@/lib/db").LoudnessAnalysis | undefined;
  trimStart: number;
  /** undefined means "to the end of the file". */
  trimEnd: number | undefined;
  soundGainDb: number;
  padGainDb: number;
  normalisation: NormalisationSettings;
}

export interface ResolvedGain {
  /** Gain contributed by normalisation, dB. */
  normDb: number;
  /** Gain actually applied: normalisation plus both manual gains, dB. */
  totalDb: number;
  /** Linear multiplier handed to the gain node. */
  linear: number;
  /** Measured loudness of the trimmed region, LUFS. null when unmeasurable. */
  measuredLufs: number | null;
  /** Loudness the sound will actually play at, LUFS. null when unmeasurable. */
  finalLufs: number | null;
  /** True peak of the trimmed region before gain, dBTP. */
  truePeakDb: number;
  /** Predicted output true peak after all gain, dBTP. */
  predictedPeakDb: number;
  /** Normalisation was reduced to respect the peak ceiling. */
  peakLimited: boolean;
  /** Normalisation boost was capped by MAX_NORM_BOOST_DB. */
  boostCapped: boolean;
  /** The summed gain hit MAX_TOTAL_GAIN_DB and was reduced. */
  gainClamped: boolean;
  /** predictedPeakDb exceeds 0 dBFS — this sound clips on its own. */
  willClip: boolean;
  /** Loudness came from a partial block. */
  estimated: boolean;
  /** No analysis available yet; normDb is 0. */
  unmeasured: boolean;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/audio/loudness/gain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "@/lib/db";
import {
  LOUDNESS_ALGO_VERSION,
  LOUDNESS_OFFSET_DB,
  MAX_GAIN,
  MAX_NORM_BOOST_DB,
  MAX_TOTAL_GAIN_DB,
} from "./constants";
import { resolveGain } from "./gain";
import { DEFAULT_NORMALISATION } from "./types";

/**
 * Builds an analysis that measures exactly `lufs` with exactly `peakDb`,
 * by inverting the block-loudness formula. Ten identical blocks means both
 * gates pass everything, so the gated result equals the block value.
 */
function fakeAnalysis(lufs: number, peakDb: number): LoudnessAnalysis {
  const w = 10 ** ((lufs - LOUDNESS_OFFSET_DB) / 10);
  const blocks = new Float32Array(10).fill(w);
  const peaks = new Float32Array(20).fill(10 ** (peakDb / 20));
  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate: 48000,
    duration: 2,
    blockMeanSquare: blocks,
    hopTruePeak: peaks,
  };
}

const base = {
  trimStart: 0,
  trimEnd: undefined,
  soundGainDb: 0,
  padGainDb: 0,
  normalisation: DEFAULT_NORMALISATION,
};

describe("resolveGain", () => {
  it("boosts a quiet file to the target", () => {
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-27, -12) });
    expect(r.normDb).toBeCloseTo(11, 1);
    expect(r.finalLufs).toBeCloseTo(-16, 1);
    expect(r.peakLimited).toBe(false);
    expect(r.willClip).toBe(false);
  });

  it("attenuates a loud file to the target", () => {
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-9, -1) });
    expect(r.normDb).toBeCloseTo(-7, 1);
    expect(r.finalLufs).toBeCloseTo(-16, 1);
  });

  it("clamps boost at the peak ceiling and flags it", () => {
    // -30 LUFS wants +14 dB, but a -0.1 dBTP peak leaves only -0.9 dB.
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-30, -0.1) });
    expect(r.normDb).toBeCloseTo(-0.9, 1);
    expect(r.peakLimited).toBe(true);
    expect(r.finalLufs).toBeCloseTo(-30.9, 1);
  });

  it("caps automatic boost at MAX_NORM_BOOST_DB", () => {
    // -60 LUFS with a very low peak would otherwise ask for +44 dB.
    const r = resolveGain({ ...base, analysis: fakeAnalysis(-60, -55) });
    expect(r.normDb).toBe(MAX_NORM_BOOST_DB);
    expect(r.boostCapped).toBe(true);
  });

  it("adds both manual gains on top of normalisation", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      soundGainDb: 3,
      padGainDb: -1,
    });
    expect(r.totalDb).toBeCloseTo(13, 1);
    expect(r.finalLufs).toBeCloseTo(-14, 1);
  });

  it("warns when manual gain pushes an otherwise-safe sound into clipping", () => {
    const safe = resolveGain({ ...base, analysis: fakeAnalysis(-27, -12) });
    expect(safe.willClip).toBe(false);

    const clipping = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      soundGainDb: 6,
    });
    expect(clipping.predictedPeakDb).toBeGreaterThan(0);
    expect(clipping.willClip).toBe(true);
  });

  it("applies no normalisation when disabled", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-27, -12),
      normalisation: { enabled: false, targetLufs: -16 },
    });
    expect(r.normDb).toBe(0);
    expect(r.linear).toBe(1);
  });

  it("applies no normalisation when the file is unmeasured", () => {
    const r = resolveGain({ ...base, analysis: undefined });
    expect(r.normDb).toBe(0);
    expect(r.unmeasured).toBe(true);
    expect(r.linear).toBe(1);
    expect(r.measuredLufs).toBeNull();
  });

  it("still applies manual gain to an unmeasured file", () => {
    const r = resolveGain({ ...base, analysis: undefined, soundGainDb: 6 });
    expect(r.totalDb).toBeCloseTo(6, 5);
    expect(r.linear).toBeCloseTo(10 ** (6 / 20), 5);
  });

  it("never exceeds MAX_GAIN and reports the clamp", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-60, -55),
      soundGainDb: 12,
      padGainDb: 12,
    });
    expect(r.totalDb).toBe(MAX_TOTAL_GAIN_DB);
    expect(r.gainClamped).toBe(true);
    expect(r.linear).toBeLessThanOrEqual(MAX_GAIN + 1e-6);
  });

  it("reports figures from the applied gain, not the requested gain", () => {
    const r = resolveGain({
      ...base,
      analysis: fakeAnalysis(-60, -55),
      soundGainDb: 12,
      padGainDb: 12,
    });
    // finalLufs must reflect totalDb after clamping, or the table lies.
    expect(r.finalLufs).toBeCloseTo(-60 + MAX_TOTAL_GAIN_DB, 1);
    expect(r.predictedPeakDb).toBeCloseTo(-55 + MAX_TOTAL_GAIN_DB, 1);
  });

  it("measures only the trimmed region", () => {
    const analysis = fakeAnalysis(-27, -12);
    const full = resolveGain({ ...base, analysis });
    const trimmed = resolveGain({
      ...base,
      analysis,
      trimStart: 0.5,
      trimEnd: 1.5,
    });
    // Constant signal, so the values agree — but the trimmed call must have
    // gone through the range path rather than ignoring the trim.
    expect(trimmed.measuredLufs).toBeCloseTo(full.measuredLufs as number, 1);
    expect(trimmed.estimated).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/gain.test.ts`
Expected: FAIL — `Failed to resolve import "./gain"`.

- [ ] **Step 4: Implement gain resolution**

Create `src/lib/audio/loudness/gain.ts`:

```ts
/**
 * Audio Module - Gain resolution
 *
 * The single source of truth for level arithmetic. Both the playback path and
 * the loudness overview call this; a second implementation anywhere would let
 * the table disagree with what you hear, which is worse than having no table.
 *
 * Every reported figure derives from `totalDb` — the gain actually applied
 * after the rails — never from the gain that was requested.
 *
 * @module lib/audio/loudness/gain
 */

import {
  MAX_NORM_BOOST_DB,
  MAX_TOTAL_GAIN_DB,
  PEAK_CEILING_DBTP,
} from "./constants";
import { measureRange } from "./query";
import type { ResolvedGain, ResolveGainInput } from "./types";

export function resolveGain(input: ResolveGainInput): ResolvedGain {
  const { analysis, soundGainDb, padGainDb, normalisation } = input;

  const manualDb = soundGainDb + padGainDb;

  if (!analysis) {
    const totalDb = Math.min(manualDb, MAX_TOTAL_GAIN_DB);
    return {
      normDb: 0,
      totalDb,
      linear: 10 ** (totalDb / 20),
      measuredLufs: null,
      finalLufs: null,
      truePeakDb: -Infinity,
      predictedPeakDb: -Infinity,
      peakLimited: false,
      boostCapped: false,
      gainClamped: manualDb > MAX_TOTAL_GAIN_DB,
      willClip: false,
      estimated: false,
      unmeasured: true,
    };
  }

  const range = measureRange(
    analysis,
    input.trimStart,
    input.trimEnd ?? analysis.duration,
  );

  const canNormalise = normalisation.enabled && range.lufs !== null;
  const rawNormDb = canNormalise
    ? normalisation.targetLufs - (range.lufs as number)
    : 0;

  const peakHeadroomDb = PEAK_CEILING_DBTP - range.truePeakDb;
  const normDb = canNormalise
    ? Math.min(rawNormDb, peakHeadroomDb, MAX_NORM_BOOST_DB)
    : 0;

  const rawTotalDb = normDb + manualDb;
  const totalDb = Math.min(rawTotalDb, MAX_TOTAL_GAIN_DB);

  const predictedPeakDb = range.truePeakDb + totalDb;

  return {
    normDb,
    totalDb,
    linear: 10 ** (totalDb / 20),
    measuredLufs: range.lufs,
    finalLufs: range.lufs === null ? null : range.lufs + totalDb,
    truePeakDb: range.truePeakDb,
    predictedPeakDb,
    peakLimited: canNormalise && rawNormDb > peakHeadroomDb,
    boostCapped: canNormalise && rawNormDb > MAX_NORM_BOOST_DB,
    gainClamped: rawTotalDb > MAX_TOTAL_GAIN_DB,
    willClip: predictedPeakDb > 0,
    estimated: range.estimated,
    unmeasured: false,
  };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/gain.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all pre-existing tests still pass, plus the four new loudness files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/audio/loudness/gain.ts src/lib/audio/loudness/gain.test.ts src/lib/audio/loudness/types.ts
git commit -m "feat(loudness): gain resolution with peak ceiling and clip prediction"
```

---

## Phase 2 — Persistence

### Task 6: Pad and profile data model

**Files:**

- Modify: `src/lib/db.ts` (`PadConfiguration`, `Profile`, `PadContent`, re-exports)
- Test: `src/lib/db.padGain.test.ts`

**Interfaces:**

- Consumes: `NormalisationSettings`, `DEFAULT_NORMALISATION` from `@/lib/audio/loudness/types`.
- Produces: `PadConfiguration.audioGainSettings`, `PadConfiguration.padGainDb`, `Profile.normalisation`, `PadPlaybackSettings`, `extractPadPlaybackSettings`.

**Background the implementer needs:** `audioGainSettings` mirrors `audioTrimSettings` (`src/lib/db.ts:65`) in shape and lifecycle deliberately, so it can follow the same code paths everywhere. Absent fields mean defaults, so no migration and no IndexedDB version bump are needed — the same approach `isDisabled` took (`src/lib/db.ts:67-72`).

- [ ] **Step 1: Add the fields to `src/lib/db.ts`**

In `PadConfiguration` (currently `src/lib/db.ts:57-79`), after `audioTrimSettings`:

```ts
  /**
   * Per-sound manual gain in dB, keyed by audio file ID. Absent or 0 means
   * unity. Applied on top of automatic normalisation, so re-normalising never
   * discards a manual adjustment.
   */
  audioGainSettings?: Record<number, number>;
  /** Whole-pad manual gain in dB, applied on top of per-sound gain. */
  padGainDb?: number;
```

In `Profile` (currently `src/lib/db.ts:19-41`), after `activePadBehavior`:

```ts
  /** Loudness normalisation settings. Absent means DEFAULT_NORMALISATION. */
  normalisation?: NormalisationSettings;
```

Add the import at the top of `src/lib/db.ts`:

```ts
import type { NormalisationSettings } from "@/lib/audio/loudness/types";
```

Re-export for convenience, next to the other type exports:

```ts
export type { NormalisationSettings };
export { DEFAULT_NORMALISATION } from "@/lib/audio/loudness/types";
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/db.padGain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PadConfiguration } from "./db";
import { extractPadPlaybackSettings } from "./db";

function pad(overrides: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    padIndex: 0,
    pageIndex: 0,
    audioFileIds: [10, 11],
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("extractPadPlaybackSettings", () => {
  it("carries every field playback depends on", () => {
    const result = extractPadPlaybackSettings(
      pad({
        audioTrimSettings: { 10: { trimStart: 1, trimEnd: 2 } },
        audioGainSettings: { 10: 3.5 },
        padGainDb: -2,
        isDisabled: true,
        name: "Horn",
      }),
    );

    expect(result.audioFileIds).toEqual([10, 11]);
    expect(result.audioTrimSettings).toEqual({
      10: { trimStart: 1, trimEnd: 2 },
    });
    expect(result.audioGainSettings).toEqual({ 10: 3.5 });
    expect(result.padGainDb).toBe(-2);
    expect(result.playbackType).toBe("round-robin");
    expect(result.isDisabled).toBe(true);
    expect(result.name).toBe("Horn");
  });

  it("defaults a pad that predates the gain fields", () => {
    const result = extractPadPlaybackSettings(pad());
    expect(result.audioGainSettings).toBeUndefined();
    expect(result.padGainDb).toBeUndefined();
  });

  it("tolerates a partial pad", () => {
    const result = extractPadPlaybackSettings({ audioFileIds: [1] });
    expect(result.audioFileIds).toEqual([1]);
    expect(result.playbackType).toBe("round-robin");
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/db.padGain.test.ts`
Expected: FAIL — `extractPadPlaybackSettings` is not exported.

- [ ] **Step 4: Add `PadPlaybackSettings` to `src/lib/db.ts`**

Replace the `PadContent` type (currently `src/lib/db.ts:1102-1107`) with:

```ts
/**
 * Everything the playback path needs from a pad.
 *
 * This exists because the trigger arguments used to be hand-copied at roughly
 * ten call sites, and every field on it is optional — so adding a field and
 * missing one site produced no compiler error, just a pad that played at the
 * wrong level when triggered from one particular path. Funnel every site
 * through extractPadPlaybackSettings instead.
 */
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
): PadPlaybackSettings {
  return {
    audioFileIds: pad.audioFileIds ?? [],
    audioTrimSettings: pad.audioTrimSettings,
    audioGainSettings: pad.audioGainSettings,
    padGainDb: pad.padGainDb,
    playbackType: pad.playbackType ?? DEFAULT_PLAYBACK_TYPE,
    isDisabled: pad.isDisabled ?? false,
    name: pad.name,
  };
}

// The part of a pad configuration that moves with the sound during a swap.
// Key bindings are deliberately excluded: they belong to the pad position.
type PadContent = PadPlaybackSettings;
```

- [ ] **Step 5: Fix the two swap construction sites**

In `swapPadConfigurations` (`src/lib/db.ts:1137-1150`), replace both literal objects:

```ts
const fromContent: PadContent = extractPadPlaybackSettings(fromExisting);
const toContent: PadContent = extractPadPlaybackSettings(toExisting ?? {});
```

- [ ] **Step 6: Run the test and the type check**

Run: `npx vitest run src/lib/db.padGain.test.ts && npx tsc --noEmit`
Expected: PASS, 3 tests, and no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db.ts src/lib/db.padGain.test.ts
git commit -m "feat(loudness): pad gain fields and PadPlaybackSettings"
```

---

### Task 7: Thread the gain fields through every trigger call site

**Files:**

- Modify: `src/lib/audio/types.ts` (`TriggerAudioArgs`)
- Modify: `src/hooks/useKeyboardListener.ts:34,93,130,621`
- Modify: `src/hooks/useSearch.ts:32,171`
- Modify: `src/components/search/SearchModal.tsx:96,160`
- Modify: `src/hooks/pad/usePadInteractions.ts:86,110,286,375`
- Modify: `src/store/playbackStore.ts:37,211`

**Interfaces:**

- Consumes: `PadPlaybackSettings`, `extractPadPlaybackSettings` from `@/lib/db`.
- Produces: `TriggerAudioArgs` carrying `audioGainSettings` and `padGainDb` at every site.

**Background the implementer needs:** These sites each hand-copy `audioTrimSettings`, `playbackType` and `isDisabled` into trigger arguments. Several of them declare their own local projection type that mirrors those fields (`useKeyboardListener.ts:34`, `useSearch.ts:32`, `playbackStore.ts:37`). Every one must gain the two new fields, or gain will apply on some trigger paths and not others — a pad that is correct when clicked but wrong when fired from an armed cue. Grep before declaring this done.

- [ ] **Step 1: Find every site**

Run: `rg -n "audioTrimSettings" src/ -g '*.ts' -g '*.tsx' | grep -v '\.test\.'`

Expected: the sites listed above. Every hit outside `src/lib/db.ts`, `src/lib/importExport.ts`, `src/lib/googleDrive/dataAccess.ts`, `src/lib/syncUtils.ts` and `src/components/modals/EditPadForm.tsx` needs the two new fields added beside it.

- [ ] **Step 2: Extend `TriggerAudioArgs`**

In `src/lib/audio/types.ts` (currently lines 93-106), after `audioTrimSettings`:

```ts
  /** Per-sound manual gain in dB, keyed by audio file ID. */
  audioGainSettings?: Record<number, number>;
  /** Whole-pad manual gain in dB. */
  padGainDb?: number;
```

- [ ] **Step 3: Update each local projection type and each copy site**

For every local type that declares `audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;` (`useKeyboardListener.ts:34`, `useSearch.ts:32`, `playbackStore.ts:37`), add immediately after it:

```ts
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
```

For every site that copies the field into an object literal, add the two new lines beside it. For example `src/hooks/pad/usePadInteractions.ts:86` becomes:

```ts
          audioTrimSettings: padConfig?.audioTrimSettings,
          audioGainSettings: padConfig?.audioGainSettings,
          padGainDb: padConfig?.padGainDb,
```

and `src/hooks/useKeyboardListener.ts:93` becomes:

```ts
        audioTrimSettings: pad.audioTrimSettings,
        audioGainSettings: pad.audioGainSettings,
        padGainDb: pad.padGainDb,
```

Apply the same two-line addition at `useKeyboardListener.ts:130,621`, `useSearch.ts:171`, `SearchModal.tsx:96,160`, `usePadInteractions.ts:110,286,375` and `playbackStore.ts:211`.

- [ ] **Step 4: Verify no site was missed**

Run:

```bash
rg -c "audioTrimSettings" src/ -g '*.ts' -g '*.tsx' | grep -v test
rg -c "audioGainSettings" src/ -g '*.ts' -g '*.tsx' | grep -v test
```

Expected: for `useKeyboardListener.ts`, `useSearch.ts`, `SearchModal.tsx`, `usePadInteractions.ts` and `playbackStore.ts`, the two counts must be **equal in each file**. Any file where they differ has a missed site.

- [ ] **Step 5: Type check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/types.ts src/hooks/useKeyboardListener.ts src/hooks/useSearch.ts src/components/search/SearchModal.tsx src/hooks/pad/usePadInteractions.ts src/store/playbackStore.ts
git commit -m "feat(loudness): thread pad gain through every trigger path"
```

---

### Task 8: Audio file ID remapping on import and sync

**Files:**

- Modify: `src/lib/importExport.ts:415-439`
- Modify: `src/lib/googleDrive/dataAccess.ts:337-351`
- Modify: `src/lib/syncUtils.ts:554-567`
- Test: `src/lib/importExport.gainRemap.test.ts`

**Interfaces:**

- Consumes: `PadConfiguration.audioGainSettings`.
- Produces: gain settings whose keys survive ID remapping.

**Background the implementer needs:** This is the highest-risk task in the plan. `audioGainSettings` is keyed by `audioFileId`, and those IDs are reassigned when a profile is imported or synced — the ID a file had on the exporting device is not the ID it gets here. Three separate places already remap `audioTrimSettings` for exactly this reason. Missing one does not throw; it silently lands the gains on the wrong sounds, so a horn plays at the volume meant for a stab. Each site gets its own regression test.

`padGainDb` is a scalar and needs no remapping.

- [ ] **Step 1: Write the failing test**

Create `src/lib/importExport.gainRemap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { remapAudioFileIdKeys } from "./importExport";

describe("remapAudioFileIdKeys", () => {
  it("translates keys through the id map", () => {
    const result = remapAudioFileIdKeys(
      { 10: 3, 11: -2 },
      new Map([
        [10, 100],
        [11, 101],
      ]),
    );
    expect(result).toEqual({ 100: 3, 101: -2 });
  });

  it("drops keys with no mapping rather than keeping a stale id", () => {
    // A stale id would attach this gain to whichever unrelated file happens
    // to hold that id locally.
    const result = remapAudioFileIdKeys({ 10: 3, 99: 6 }, new Map([[10, 100]]));
    expect(result).toEqual({ 100: 3 });
  });

  it("returns undefined for undefined input", () => {
    expect(remapAudioFileIdKeys(undefined, new Map())).toBeUndefined();
  });

  it("works for trim settings as well as gain", () => {
    const result = remapAudioFileIdKeys(
      { 10: { trimStart: 1, trimEnd: 2 } },
      new Map([[10, 100]]),
    );
    expect(result).toEqual({ 100: { trimStart: 1, trimEnd: 2 } });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/importExport.gainRemap.test.ts`
Expected: FAIL — `remapAudioFileIdKeys` is not exported.

- [ ] **Step 3: Add the shared helper to `src/lib/importExport.ts`**

Near the top of the file, beside the other exported helpers:

```ts
/**
 * Translates a record keyed by audio file ID through an old-id to new-id map.
 *
 * Audio file IDs are reassigned on import and on sync, so every
 * Record<audioFileId, …> field on a pad must go through this. Keys with no
 * mapping are dropped rather than kept: a stale ID would silently attach the
 * setting to whichever unrelated file happens to hold that ID locally.
 */
export function remapAudioFileIdKeys<T>(
  settings: Record<number, T> | undefined,
  idMap: Map<number, number>,
): Record<number, T> | undefined {
  if (!settings) return undefined;

  const remapped: Record<number, T> = {};
  for (const [oldId, value] of Object.entries(settings)) {
    const newId = idMap.get(Number(oldId));
    if (newId !== undefined) remapped[newId] = value;
  }
  return remapped;
}
```

- [ ] **Step 4: Use it at all three sites**

In `src/lib/importExport.ts` around lines 415-439, replace the bespoke trim mapping with two calls and add the gain field to the constructed pad:

```ts
const mappedTrimSettings = remapAudioFileIdKeys(
  pad.audioTrimSettings,
  audioFileIdMap,
);
const mappedGainSettings = remapAudioFileIdKeys(
  pad.audioGainSettings,
  audioFileIdMap,
);
```

and in the object literal at line 439:

```ts
      audioTrimSettings: mappedTrimSettings,
      audioGainSettings: mappedGainSettings,
      padGainDb: pad.padGainDb,
```

In `src/lib/googleDrive/dataAccess.ts` around lines 337-351, alongside the existing trim mapping:

```ts
padWithProfileId.audioTrimSettings = remapAudioFileIdKeys(
  padWithProfileId.audioTrimSettings,
  idMap,
);
padWithProfileId.audioGainSettings = remapAudioFileIdKeys(
  padWithProfileId.audioGainSettings,
  idMap,
);
```

Import the helper: `import { remapAudioFileIdKeys } from "@/lib/importExport";`

In `src/lib/syncUtils.ts` around lines 554-567, alongside `translatedTrimSettings`:

```ts
const translatedGainSettings = remapAudioFileIdKeys(
  pad.audioGainSettings,
  idMap,
);
```

and add to the constructed pad at line 567:

```ts
          audioTrimSettings: translatedTrimSettings,
          audioGainSettings: translatedGainSettings,
          padGainDb: pad.padGainDb,
```

Adjust the surrounding variable names to match whatever the existing code calls its ID map at each site — the three sites do not use the same name.

- [ ] **Step 5: Run the test and the suite**

Run: `npx vitest run src/lib/importExport.gainRemap.test.ts && npm test && npx tsc --noEmit`
Expected: PASS, 4 new tests, no regressions, no type errors.

- [ ] **Step 6: Verify no remap site was missed**

Run: `rg -n "audioTrimSettings" src/lib/importExport.ts src/lib/googleDrive/dataAccess.ts src/lib/syncUtils.ts`

Every line that reads or writes `audioTrimSettings` must have an `audioGainSettings` counterpart within a few lines. Confirm by eye.

- [ ] **Step 7: Commit**

```bash
git add src/lib/importExport.ts src/lib/googleDrive/dataAccess.ts src/lib/syncUtils.ts src/lib/importExport.gainRemap.test.ts
git commit -m "fix(loudness): remap gain settings keys on import and sync"
```

---

## Phase 3 — Playback

### Task 9: Warm loudness cache

**Files:**

- Create: `src/lib/audio/loudness/cache.ts`
- Test: `src/lib/audio/loudness/cache.test.ts`

**Interfaces:**

- Consumes: `LoudnessAnalysis` from `@/lib/db`.
- Produces: `setCachedLoudness(id, analysis)`, `getCachedLoudness(id): LoudnessAnalysis | undefined`, `clearLoudnessCache()`, `warmLoudnessCache(entries)`, `getLoudnessCacheSize()`.

**Background the implementer needs:** Gain resolution at trigger time must be synchronous. Adding an `await` to the playback path would add jitter to a live-performance tool, which is not acceptable — this app is used on stage. So the analysis for the active profile is held in memory. It is small: ~80 bytes per second of audio, so a 30-minute board is about 150 KB.

- [ ] **Step 1: Write the failing test**

Create `src/lib/audio/loudness/cache.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "@/lib/db";
import {
  clearLoudnessCache,
  getCachedLoudness,
  getLoudnessCacheSize,
  setCachedLoudness,
  warmLoudnessCache,
} from "./cache";

function analysis(duration = 1): LoudnessAnalysis {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration,
    blockMeanSquare: new Float32Array(7),
    hopTruePeak: new Float32Array(10),
  };
}

describe("loudness cache", () => {
  beforeEach(() => clearLoudnessCache());

  it("stores and retrieves by audio file id", () => {
    setCachedLoudness(42, analysis(2));
    expect(getCachedLoudness(42)?.duration).toBe(2);
  });

  it("returns undefined for an unknown id", () => {
    expect(getCachedLoudness(999)).toBeUndefined();
  });

  it("replaces the whole cache when warmed", () => {
    setCachedLoudness(1, analysis());
    warmLoudnessCache([
      [2, analysis()],
      [3, analysis()],
    ]);
    expect(getCachedLoudness(1)).toBeUndefined();
    expect(getCachedLoudness(2)).toBeDefined();
    expect(getLoudnessCacheSize()).toBe(2);
  });

  it("clears", () => {
    setCachedLoudness(1, analysis());
    clearLoudnessCache();
    expect(getLoudnessCacheSize()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/cache.test.ts`
Expected: FAIL — `Failed to resolve import "./cache"`.

- [ ] **Step 3: Implement the cache**

Create `src/lib/audio/loudness/cache.ts`:

```ts
/**
 * Audio Module - Loudness cache
 *
 * Holds the analysis for the active profile in memory so gain resolution at
 * trigger time is synchronous. Awaiting a database read before playback would
 * add jitter to a live-performance tool, which is not acceptable here.
 *
 * Small enough not to need eviction: ~80 bytes per second of audio, so a
 * 30-minute board is about 150 KB.
 *
 * @module lib/audio/loudness/cache
 */

import type { LoudnessAnalysis } from "@/lib/db";

const cache = new Map<number, LoudnessAnalysis>();

export function setCachedLoudness(
  audioFileId: number,
  analysis: LoudnessAnalysis,
): void {
  cache.set(audioFileId, analysis);
}

export function getCachedLoudness(
  audioFileId: number,
): LoudnessAnalysis | undefined {
  return cache.get(audioFileId);
}

/** Replaces the entire cache — used when switching profile. */
export function warmLoudnessCache(
  entries: Iterable<[number, LoudnessAnalysis]>,
): void {
  cache.clear();
  for (const [id, analysis] of entries) cache.set(id, analysis);
}

export function clearLoudnessCache(): void {
  cache.clear();
}

export function getLoudnessCacheSize(): number {
  return cache.size;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/cache.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio/loudness/cache.ts src/lib/audio/loudness/cache.test.ts
git commit -m "feat(loudness): in-memory analysis cache for synchronous gain resolution"
```

---

### Task 10: Wire gain into playback

**Files:**

- Modify: `src/lib/audio/playback.ts:64,374`
- Modify: `src/lib/audio/controls.ts:372-410`
- Modify: `src/store/profileStore.ts` (add `getNormalisationSettings`)
- Test: `src/lib/audio/playback.clamp.test.ts`

**Interfaces:**

- Consumes: `resolveGain`, `getCachedLoudness`, `MAX_GAIN`, `DEFAULT_NORMALISATION`.
- Produces: `PlayAudioParams.volume` finally being set; `useProfileStore.getState().getNormalisationSettings()`.

**Background the implementer needs:** `PlayAudioParams.volume` already exists (`src/lib/audio/types.ts:118`) and is already read into the gain node on both playback paths — the buffer path at `playback.ts:255` and the media-element path at `playback.ts:358`. No caller has ever set it. This task sets it.

The clamp at `playback.ts:64` and `:374` is `Math.min(1, volume)`. Left alone, no quiet file could ever be boosted and normalisation would silently do half its job. It becomes `Math.min(MAX_GAIN, volume)`.

Fades need no change: `fadeOutTrack` reads `gain.value` and ramps from it (`playback.ts:651`), so a track sitting at 0.4 fades from 0.4 rather than jumping to full volume first.

For reading the profile setting from the audio layer, follow the existing precedent at `controls.ts:316`, which does `useProfileStore.getState().getActivePadBehavior()`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/audio/playback.clamp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_GAIN } from "./loudness/constants";
import { clampPlaybackGain } from "./playback";

describe("clampPlaybackGain", () => {
  it("allows boost above unity so quiet files can reach target", () => {
    // The old clamp of 1 made normalisation unable to raise anything.
    expect(clampPlaybackGain(4)).toBe(4);
  });

  it("clamps at MAX_GAIN", () => {
    expect(clampPlaybackGain(MAX_GAIN * 10)).toBe(MAX_GAIN);
  });

  it("floors at zero", () => {
    expect(clampPlaybackGain(-3)).toBe(0);
  });

  it("passes unity through", () => {
    expect(clampPlaybackGain(1)).toBe(1);
  });

  it("treats a non-finite value as unity rather than silencing the pad", () => {
    expect(clampPlaybackGain(Number.NaN)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/playback.clamp.test.ts`
Expected: FAIL — `clampPlaybackGain` is not exported.

- [ ] **Step 3: Lift the clamp in `src/lib/audio/playback.ts`**

Add near the top, after the imports:

```ts
import { MAX_GAIN } from "./loudness/constants";

/**
 * Clamps a resolved gain for the gain node.
 *
 * The ceiling used to be 1, which meant normalisation could attenuate a loud
 * file but never raise a quiet one. A non-finite value falls back to unity so
 * a bad measurement mutes nothing.
 */
export function clampPlaybackGain(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(MAX_GAIN, volume));
}
```

Replace the clamp in `createAudioSource` (currently `src/lib/audio/playback.ts:62-65`):

```ts
const gainNode = context.createGain();
gainNode.gain.setValueAtTime(clampPlaybackGain(volume), context.currentTime);
```

And the media-element clamp at `src/lib/audio/playback.ts:374`:

```ts
gainNode.gain.setValueAtTime(clampPlaybackGain(volume), context.currentTime);
```

- [ ] **Step 4: Run the clamp test**

Run: `npx vitest run src/lib/audio/playback.clamp.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the profile getter**

In `src/store/profileStore.ts`, beside `getActivePadBehavior` (currently around line 836):

```ts
        getNormalisationSettings: () => {
          const { profiles, activeProfileId } = get();
          const activeProfile = profiles.find((p) => p.id === activeProfileId);
          return activeProfile?.normalisation ?? DEFAULT_NORMALISATION;
        },
```

Add `getNormalisationSettings: () => NormalisationSettings;` to the `ProfileState` interface, and import both `DEFAULT_NORMALISATION` and the type from `@/lib/db`.

- [ ] **Step 6: Resolve gain in `src/lib/audio/controls.ts`**

Add imports:

```ts
import { getCachedLoudness } from "./loudness/cache";
import { resolveGain } from "./loudness/gain";
```

Destructure the new args alongside `audioTrimSettings` (currently `src/lib/audio/controls.ts:274`):

```ts
    audioGainSettings,
    padGainDb,
```

Replace the trim lookup (currently `src/lib/audio/controls.ts:371-372`) with:

```ts
// Look up trim and gain for this specific audio file. Gain resolution is
// synchronous by design — the analysis is held in memory precisely so the
// trigger path never has to await a database read.
const trimForFile = audioTrimSettings?.[audioFileId];
const resolvedGain = resolveGain({
  analysis: getCachedLoudness(audioFileId),
  trimStart: trimForFile?.trimStart ?? 0,
  trimEnd: trimForFile?.trimEnd,
  soundGainDb: audioGainSettings?.[audioFileId] ?? 0,
  padGainDb: padGainDb ?? 0,
  normalisation: useProfileStore.getState().getNormalisationSettings(),
});
```

Add `volume` to `buildPlayParams` (currently `src/lib/audio/controls.ts:386-410`), directly after `padInfo`:

```ts
      volume: resolvedGain.linear,
```

- [ ] **Step 7: Expose the resolved gain to E2E**

Still in `buildPlayParams`, before the `return`, and using the existing hook helper (`src/lib/testHooks.ts`):

```ts
// Resolved gain is not observable from the DOM, so E2E asserts on it here.
// Read-only view of state the UI cannot otherwise reveal.
exposeE2EHook("__impampLastResolvedGain", {
  playbackKey,
  audioFileId,
  totalDb: resolvedGain.totalDb,
  normDb: resolvedGain.normDb,
  linear: resolvedGain.linear,
  willClip: resolvedGain.willClip,
  unmeasured: resolvedGain.unmeasured,
});
```

`exposeE2EHook` is already imported in `playback.ts`; add the import to `controls.ts` if absent: `import { exposeE2EHook } from "@/lib/testHooks";`

- [ ] **Step 8: Type check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/audio/playback.ts src/lib/audio/controls.ts src/lib/audio/playback.clamp.test.ts src/store/profileStore.ts
git commit -m "feat(loudness): apply resolved gain at playback and lift the unity clamp"
```

---

## Phase 4 — Analysis pipeline

### Task 11: Analyse on import and backfill on idle

**Files:**

- Create: `src/lib/audio/loudness/pipeline.ts`
- Modify: `src/lib/db.ts` (add `updateAudioFileLoudness`, `findUnanalysedAudioFileIds`)
- Modify: `src/components/ClientSideInitializer.tsx` (kick off the backfill)
- Test: `src/lib/audio/loudness/pipeline.test.ts`

**Interfaces:**

- Consumes: `analyseAudioBuffer`, `warmLoudnessCache`, `setCachedLoudness`, `decodeAudioBlob` from `@/lib/audio/decoder`, `getCachedAudioBuffer` from `@/lib/audio/cache`.
- Produces: `analyseAndStore(audioFileId): Promise<LoudnessAnalysis | null>`, `runBackfill(onProgress): Promise<void>`, `loadProfileLoudness(profileId): Promise<void>`.

**Background the implementer needs:** Analysis is never blocking. A file being imported is already being decoded, so analysing it in the same pass is nearly free. Existing files are swept in the background. Until a file is measured, `resolveGain` returns `normDb: 0` and it plays exactly as it does today — the degradation is graceful and the overview shows `unmeasured` rather than a wrong number.

One trap: iterating `audioFiles` to find unanalysed records must use a cursor and must not retain `blob` references, or the scan materialises every audio blob in the profile at once.

- [ ] **Step 1: Add the database helpers to `src/lib/db.ts`**

```ts
/** Stores a loudness analysis against an audio file. */
export async function updateAudioFileLoudness(
  id: number,
  loudness: LoudnessAnalysis,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const existing = await tx.store.get(id);
  if (existing) {
    await tx.store.put({ ...existing, loudness });
  }
  await tx.done;
}

/**
 * Lists audio file IDs that need analysis.
 *
 * Iterates with a cursor and reads only the two fields it needs — pulling
 * whole records here would materialise every audio blob at once.
 */
export async function findUnanalysedAudioFileIds(
  currentAlgoVersion: number,
): Promise<number[]> {
  const db = await getDb();
  const ids: number[] = [];
  let cursor = await db.transaction("audioFiles").store.openCursor();

  while (cursor) {
    const loudness = cursor.value.loudness;
    if (!loudness || loudness.algoVersion !== currentAlgoVersion) {
      if (cursor.value.id !== undefined) ids.push(cursor.value.id);
    }
    cursor = await cursor.continue();
  }

  return ids;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/audio/loudness/pipeline.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { nextBackfillBatch, shouldAnalyse } from "./pipeline";
import { LOUDNESS_ALGO_VERSION } from "./constants";

describe("shouldAnalyse", () => {
  it("analyses a file with no analysis", () => {
    expect(shouldAnalyse(undefined)).toBe(true);
  });

  it("re-analyses a file from an older algorithm version", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION - 1,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(true);
  });

  it("leaves a current analysis alone", () => {
    expect(
      shouldAnalyse({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: new Float32Array(0),
        hopTruePeak: new Float32Array(0),
      }),
    ).toBe(false);
  });
});

describe("nextBackfillBatch", () => {
  it("takes at most the batch size", () => {
    expect(nextBackfillBatch([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });

  it("takes everything when fewer remain than the batch size", () => {
    expect(nextBackfillBatch([1], 3)).toEqual([1]);
  });

  it("returns empty for an empty queue", () => {
    expect(nextBackfillBatch([], 3)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/pipeline.test.ts`
Expected: FAIL — `Failed to resolve import "./pipeline"`.

- [ ] **Step 4: Implement the pipeline**

Create `src/lib/audio/loudness/pipeline.ts`:

```ts
/**
 * Audio Module - Loudness analysis pipeline
 *
 * Analysis is never blocking. Imports are analysed in the same pass that
 * already decodes them; existing files are swept in the background on idle.
 * Until a file is analysed it resolves to 0 dB of normalisation and plays
 * exactly as it did before this feature existed.
 *
 * @module lib/audio/loudness/pipeline
 */

import {
  findUnanalysedAudioFileIds,
  getAudioFile,
  getAudioFileIdsForProfile,
  updateAudioFileLoudness,
  type LoudnessAnalysis,
} from "@/lib/db";
import { getCachedAudioBuffer } from "@/lib/audio/cache";
import { decodeAudioBlob } from "@/lib/audio/decoder";
import { analyseAudioBuffer } from "./analyse";
import { setCachedLoudness, warmLoudnessCache } from "./cache";
import { LOUDNESS_ALGO_VERSION } from "./constants";

/** How many files to analyse per idle slice. */
const BACKFILL_BATCH_SIZE = 3;

export function shouldAnalyse(loudness: LoudnessAnalysis | undefined): boolean {
  return !loudness || loudness.algoVersion !== LOUDNESS_ALGO_VERSION;
}

export function nextBackfillBatch(
  queue: number[],
  batchSize: number,
): number[] {
  return queue.slice(0, batchSize);
}

/**
 * Analyses one audio file and stores the result. Reuses an already-decoded
 * buffer when the cache has one, since decoding is the expensive part.
 */
export async function analyseAndStore(
  audioFileId: number,
): Promise<LoudnessAnalysis | null> {
  try {
    let buffer = getCachedAudioBuffer(audioFileId);

    if (!buffer) {
      const file = await getAudioFile(audioFileId);
      if (!file) return null;
      buffer = await decodeAudioBlob(file.blob);
    }

    const analysis = analyseAudioBuffer(buffer);
    await updateAudioFileLoudness(audioFileId, analysis);
    setCachedLoudness(audioFileId, analysis);
    return analysis;
  } catch (error) {
    // A file we cannot decode simply stays unanalysed and plays at 0 dB.
    console.warn(
      `[Loudness] Could not analyse audio file ${audioFileId}:`,
      error,
    );
    return null;
  }
}

/** Loads every stored analysis for a profile into the in-memory cache. */
export async function loadProfileLoudness(profileId: number): Promise<void> {
  if (typeof window === "undefined") return;

  const ids = await getAudioFileIdsForProfile(profileId);
  const entries: [number, LoudnessAnalysis][] = [];

  for (const id of ids) {
    const file = await getAudioFile(id);
    if (file?.loudness && !shouldAnalyse(file.loudness)) {
      entries.push([id, file.loudness]);
    }
  }

  warmLoudnessCache(entries);
}

/** Schedules work for when the browser is idle, falling back to a timer. */
function onIdle(callback: () => void): void {
  const ric = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
    }
  ).requestIdleCallback;

  if (typeof ric === "function") ric(callback);
  else setTimeout(callback, 200);
}

/**
 * Analyses every file that needs it, a few at a time, on idle.
 * Resolves once the queue is empty.
 */
export async function runBackfill(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (typeof window === "undefined") return;

  const queue = await findUnanalysedAudioFileIds(LOUDNESS_ALGO_VERSION);
  const total = queue.length;
  if (total === 0) {
    onProgress?.(0, 0);
    return;
  }

  let done = 0;
  let remaining = queue;

  return new Promise((resolve) => {
    const step = () => {
      const batch = nextBackfillBatch(remaining, BACKFILL_BATCH_SIZE);
      if (batch.length === 0) {
        resolve();
        return;
      }
      remaining = remaining.slice(batch.length);

      void Promise.all(batch.map((id) => analyseAndStore(id))).then(() => {
        done += batch.length;
        onProgress?.(done, total);
        onIdle(step);
      });
    };

    onIdle(step);
  });
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/pipeline.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Hook analysis into import**

In `src/lib/db.ts`, inside `addAudioFile` (currently `src/lib/db.ts:447`), after the record is written and its ID is known, fire analysis without awaiting it so imports do not slow down:

```ts
// Analyse in the background. The file plays at 0 dB normalisation until
// this lands, which is exactly how it behaved before the feature existed.
if (typeof window !== "undefined") {
  void import("@/lib/audio/loudness/pipeline").then(({ analyseAndStore }) =>
    analyseAndStore(newId),
  );
}
```

Use a dynamic import to keep `db.ts` free of a static dependency on the audio layer.

- [ ] **Step 7: Kick off the backfill and warm the cache on profile activation**

In `src/components/ClientSideInitializer.tsx`, inside the effect that reacts to the active profile changing, add:

```ts
useEffect(() => {
  if (activeProfileId === null) return;

  let cancelled = false;
  void (async () => {
    const { loadProfileLoudness, runBackfill } =
      await import("@/lib/audio/loudness/pipeline");
    await loadProfileLoudness(activeProfileId);
    if (cancelled) return;
    await runBackfill();
    if (cancelled) return;
    // Pick up anything the backfill just measured.
    await loadProfileLoudness(activeProfileId);
  })();

  return () => {
    cancelled = true;
  };
}, [activeProfileId]);
```

- [ ] **Step 8: Type check and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/audio/loudness/pipeline.ts src/lib/audio/loudness/pipeline.test.ts src/lib/db.ts src/components/ClientSideInitializer.tsx
git commit -m "feat(loudness): analyse on import and backfill existing files on idle"
```

---

## Phase 5 — User interface

### Task 12: Profile normalisation settings

**Files:**

- Modify: `src/store/profileStore.ts` (add `setNormalisation`)
- Modify: `src/components/profiles/ProfileCard.tsx`
- Test: manual, plus the type check

**Interfaces:**

- Consumes: `NormalisationSettings`, `DEFAULT_NORMALISATION`, `runBackfill`.
- Produces: `useProfileStore.getState().setNormalisation(settings)`.

- [ ] **Step 1: Add the store action**

In `src/store/profileStore.ts`, modelled on `setActivePadBehavior` (currently around line 846):

```ts
        setNormalisation: async (settings: NormalisationSettings) => {
          const { activeProfileId } = get();
          if (activeProfileId === null) return;

          await updateProfile(activeProfileId, { normalisation: settings });

          set((state) => ({
            profiles: state.profiles.map((p) =>
              p.id === activeProfileId
                ? { ...p, normalisation: settings, updatedAt: new Date() }
                : p,
            ),
          }));
        },
```

Declare it on `ProfileState`:

```ts
setNormalisation: (settings: NormalisationSettings) => Promise<void>;
```

- [ ] **Step 2: Add the settings UI to `ProfileCard.tsx`**

Inside the profile settings section, following the existing control patterns in that file:

```tsx
<div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
  <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
    Loudness normalisation
  </h4>
  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
    Levels every sound to the same loudness automatically. Your per-sound and
    per-pad gain adjustments are applied on top and are never overwritten.
  </p>

  <label className="mt-3 flex items-center gap-2">
    <input
      type="checkbox"
      checked={normalisation.enabled}
      onChange={(e) =>
        void setNormalisation({ ...normalisation, enabled: e.target.checked })
      }
      className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
      data-testid="normalisation-enabled"
    />
    <span className="text-sm text-gray-700 dark:text-gray-300">
      Normalise automatically
    </span>
  </label>

  <label className="mt-3 block">
    <span className="text-sm text-gray-700 dark:text-gray-300">
      Target loudness: {normalisation.targetLufs} LUFS
    </span>
    <input
      type="range"
      min={-30}
      max={-9}
      step={1}
      value={normalisation.targetLufs}
      disabled={!normalisation.enabled}
      onChange={(e) =>
        void setNormalisation({
          ...normalisation,
          targetLufs: Number(e.target.value),
        })
      }
      className="mt-1 w-full disabled:opacity-50"
      data-testid="normalisation-target"
    />
  </label>

  {backfill.total > 0 && backfill.done < backfill.total && (
    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
      Analysing {backfill.done}/{backfill.total}…
    </p>
  )}
</div>
```

Read `normalisation` from the active profile with `?? DEFAULT_NORMALISATION`, and hold `backfill` as component state updated from `runBackfill`'s `onProgress` callback.

- [ ] **Step 3: Verify in the running app**

Ask the user to confirm a dev server is running, then open a profile's settings, toggle normalisation off and on, and move the target slider. Confirm the value persists across a page reload.

- [ ] **Step 4: Type check and commit**

```bash
npx tsc --noEmit && npm run lint
git add src/store/profileStore.ts src/components/profiles/ProfileCard.tsx
git commit -m "feat(loudness): per-profile normalisation settings"
```

---

### Task 13: Per-sound and per-pad gain controls

**Files:**

- Create: `src/components/GainControl.tsx`
- Modify: `src/components/modals/EditPadForm.tsx`
- Modify: `src/types/forms.ts`
- Test: `src/components/GainControl.test.tsx` is **not** written — Vitest runs in the node environment with no DOM. Cover the formatting helper instead.
- Test: `src/lib/audio/loudness/format.test.ts`
- Create: `src/lib/audio/loudness/format.ts`

**Interfaces:**

- Consumes: `MANUAL_GAIN_RANGE_DB`.
- Produces: `formatGainDb(db): string`, `gainToneClass(db): string`, and the `GainControl` component.

- [ ] **Step 1: Write the failing test**

Create `src/lib/audio/loudness/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatGainDb, formatLufs, gainToneClass } from "./format";

describe("formatGainDb", () => {
  it("shows a sign for boost", () => {
    expect(formatGainDb(6)).toBe("+6.0");
  });

  it("shows a minus for cut", () => {
    expect(formatGainDb(-3.25)).toBe("−3.3");
  });

  it("shows unity without a sign", () => {
    expect(formatGainDb(0)).toBe("0.0");
  });
});

describe("gainToneClass", () => {
  it("de-emphasises unity", () => {
    expect(gainToneClass(0)).toContain("text-gray");
  });

  it("uses distinct classes for boost and cut", () => {
    expect(gainToneClass(3)).not.toBe(gainToneClass(-3));
  });

  // Colour must never be the only signal; the number is always rendered
  // alongside, so these classes are decoration rather than meaning.
  it("returns a class for every input", () => {
    for (const db of [-24, -1, 0, 1, 12]) {
      expect(typeof gainToneClass(db)).toBe("string");
    }
  });
});

describe("formatLufs", () => {
  it("renders a measurement to one decimal", () => {
    expect(formatLufs(-16.04)).toBe("−16.0");
  });

  it("renders an em dash for an unmeasurable value", () => {
    expect(formatLufs(null)).toBe("—");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/format.test.ts`
Expected: FAIL — `Failed to resolve import "./format"`.

- [ ] **Step 3: Implement the formatters**

Create `src/lib/audio/loudness/format.ts`:

```ts
/**
 * Audio Module - Loudness display formatting
 *
 * Uses a real minus sign (U+2212) rather than a hyphen so columns of numbers
 * align and negative values read clearly at small sizes.
 *
 * @module lib/audio/loudness/format
 */

const MINUS = "−";

/** Formats a gain in dB with an explicit sign. Never returns bare "0". */
export function formatGainDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return "0.0";
  const magnitude = Math.abs(rounded).toFixed(1);
  return rounded > 0 ? `+${magnitude}` : `${MINUS}${magnitude}`;
}

/** Formats a LUFS measurement, or an em dash when there is nothing to show. */
export function formatLufs(lufs: number | null): string {
  if (lufs === null || !Number.isFinite(lufs)) return "—";
  const rounded = Math.round(lufs * 10) / 10;
  const magnitude = Math.abs(rounded).toFixed(1);
  return rounded < 0 ? `${MINUS}${magnitude}` : magnitude;
}

/**
 * Tailwind classes marking a gain as boosted, cut or unity.
 *
 * Decoration only — the signed number is always rendered beside it, so no
 * meaning is lost to a colour-blind reader or a screen reader.
 */
export function gainToneClass(db: number): string {
  if (Math.abs(db) < 0.05) return "text-gray-500 dark:text-gray-400";
  return db > 0
    ? "text-amber-700 dark:text-amber-300"
    : "text-sky-700 dark:text-sky-300";
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/format.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Build the reusable control**

Create `src/components/GainControl.tsx`:

```tsx
"use client";

import { MANUAL_GAIN_RANGE_DB } from "@/lib/audio/loudness/constants";
import { formatGainDb, gainToneClass } from "@/lib/audio/loudness/format";

interface GainControlProps {
  valueDb: number;
  onChange: (db: number) => void;
  label: string;
  testId?: string;
  compact?: boolean;
}

/**
 * A dB slider with a reset-to-unity affordance.
 *
 * The numeric value is always rendered, so the colour marking is decoration
 * and never the only signal.
 */
export default function GainControl({
  valueDb,
  onChange,
  label,
  testId,
  compact = false,
}: GainControlProps) {
  return (
    <div className={compact ? "flex items-center gap-2" : "block"}>
      <label className="flex items-center gap-2">
        <span className="sr-only">{label}</span>
        <input
          type="range"
          min={MANUAL_GAIN_RANGE_DB.min}
          max={MANUAL_GAIN_RANGE_DB.max}
          step={0.5}
          value={valueDb}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className={compact ? "w-24" : "w-full"}
          data-testid={testId}
        />
      </label>
      <span
        className={`w-12 text-right font-mono text-xs tabular-nums ${gainToneClass(valueDb)}`}
        data-testid={testId ? `${testId}-value` : undefined}
      >
        {formatGainDb(valueDb)}
      </span>
      <button
        type="button"
        onClick={() => onChange(0)}
        disabled={valueDb === 0}
        className="text-xs text-gray-500 underline disabled:opacity-40 dark:text-gray-400"
        aria-label={`Reset ${label} to 0 dB`}
      >
        Reset
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Add both controls to `EditPadForm.tsx`**

Extend `src/types/forms.ts` (currently line 19) with:

```ts
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
```

In the sound list item (currently `src/components/modals/EditPadForm.tsx:326-350`), beside the trim and remove buttons:

```tsx
<GainControl
  compact
  label={`Gain for ${sound.name}`}
  valueDb={values.audioGainSettings?.[sound.fileId] ?? 0}
  testId={`edit-pad-gain-sound-${sound.fileId}`}
  onChange={(db) =>
    updateValue("audioGainSettings", {
      ...(values.audioGainSettings ?? {}),
      [sound.fileId]: db,
    })
  }
/>
```

And below the sound list, a whole-pad control:

```tsx
<div className="mt-4">
  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
    Pad gain
  </span>
  <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
    Applied on top of every sound&apos;s own gain.
  </p>
  <GainControl
    label="Pad gain"
    valueDb={values.padGainDb ?? 0}
    testId="edit-pad-gain-pad"
    onChange={(db) => updateValue("padGainDb", db)}
  />
</div>
```

- [ ] **Step 7: Verify in the running app**

Open a pad's edit modal, move a per-sound gain slider and the pad gain slider, save, reopen, and confirm both persisted. Then trigger the pad and confirm the level audibly changed.

- [ ] **Step 8: Type check, lint and commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/components/GainControl.tsx src/components/modals/EditPadForm.tsx src/types/forms.ts src/lib/audio/loudness/format.ts src/lib/audio/loudness/format.test.ts
git commit -m "feat(loudness): per-sound and per-pad gain controls"
```

---

### Task 14: Live loudness readout in the waveform trimmer

**Files:**

- Modify: `src/components/WaveformTrimmer.tsx`

**Interfaces:**

- Consumes: `resolveGain`, `getCachedLoudness`, `formatGainDb`, `formatLufs`.
- Produces: nothing new.

**Background the implementer needs:** This component already decodes and draws the file, so it is the natural home for the full readout. Because `measureRange` is a slice over cached floats, the numbers can update on every frame of a trim drag without any decoding.

- [ ] **Step 1: Add the readout**

Inside `WaveformTrimmer`, alongside the existing `trimStart` / `trimEnd` state (currently lines 91-92):

```tsx
const resolved = useMemo(() => {
  return resolveGain({
    analysis: getCachedLoudness(audioFileId),
    trimStart,
    trimEnd,
    soundGainDb,
    padGainDb,
    normalisation,
  });
}, [audioFileId, trimStart, trimEnd, soundGainDb, padGainDb, normalisation]);
```

Render it below the waveform:

```tsx
<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
  <span className="text-gray-600 dark:text-gray-400">
    Measured{" "}
    <span className="font-mono tabular-nums">
      {formatLufs(resolved.measuredLufs)}
    </span>{" "}
    LUFS
    {resolved.estimated && (
      <span className="ml-1 text-gray-500 dark:text-gray-400">(estimated)</span>
    )}
  </span>

  <span className="text-gray-600 dark:text-gray-400">
    Normalisation{" "}
    <span className="font-mono tabular-nums">
      {formatGainDb(resolved.normDb)}
    </span>{" "}
    dB
  </span>

  <span className="text-gray-900 dark:text-gray-100">
    Plays at{" "}
    <span className="font-mono tabular-nums">
      {formatLufs(resolved.finalLufs)}
    </span>{" "}
    LUFS
  </span>

  {resolved.peakLimited && (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
      ⚠ peak limited
    </span>
  )}

  {resolved.willClip && (
    <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-800 dark:bg-red-900/40 dark:text-red-200">
      ⚠ clips by {formatGainDb(resolved.predictedPeakDb)} dB
    </span>
  )}

  {resolved.unmeasured && (
    <span className="text-gray-500 dark:text-gray-400">analysing…</span>
  )}
</div>
```

Add `soundGainDb`, `padGainDb` and `normalisation` to the component's props, passed down from `EditPadForm`.

- [ ] **Step 2: Verify in the running app**

Open the trimmer for a sound, drag a trim handle across a loud and a quiet passage, and confirm the measured LUFS and the normalisation figure both change live with no stutter.

- [ ] **Step 3: Type check, lint and commit**

```bash
npx tsc --noEmit && npm run lint
git add src/components/WaveformTrimmer.tsx src/components/modals/EditPadForm.tsx
git commit -m "feat(loudness): live loudness readout while trimming"
```

---

### Task 15: Loudness overview — rows and the sounds tab

**Files:**

- Create: `src/lib/audio/loudness/overview.ts`
- Create: `src/components/modals/LoudnessOverviewModalContent.tsx`
- Modify: `src/components/modals/modalRegistry.ts`
- Test: `src/lib/audio/loudness/overview.test.ts`

**Interfaces:**

- Consumes: `resolveGain`, `getCachedLoudness`, `PadConfiguration`.
- Produces: `SoundRow`, `PadRow`, `buildSoundRows(pads, options)`, `buildPadRows(soundRows)`, `sortRows(rows, key, direction)`, `filterProblemRows(rows, target)`, and `ModalType.LOUDNESS_OVERVIEW`.

**Background the implementer needs:** Every row must come from `resolveGain` — the same function the playback path calls. Do not recompute levels here. A table that disagrees with what you hear is worse than no table.

- [ ] **Step 1: Write the failing test**

Create `src/lib/audio/loudness/overview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PadConfiguration } from "@/lib/db";
import {
  buildPadRows,
  buildSoundRows,
  filterProblemRows,
  sortRows,
  type SoundRow,
} from "./overview";
import { DEFAULT_NORMALISATION } from "./types";

function pad(overrides: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    padIndex: 0,
    pageIndex: 0,
    audioFileIds: [10],
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const options = {
  normalisation: DEFAULT_NORMALISATION,
  getAnalysis: () => undefined,
  getSoundName: (id: number) => `sound-${id}`,
  getBankName: () => "Bank 1",
};

function row(overrides: Partial<SoundRow>): SoundRow {
  return {
    key: "0-0-10",
    pageIndex: 0,
    padIndex: 0,
    bankName: "Bank 1",
    padName: "Pad",
    audioFileId: 10,
    soundName: "sound-10",
    gain: {
      normDb: 0,
      totalDb: 0,
      linear: 1,
      measuredLufs: -16,
      finalLufs: -16,
      truePeakDb: -6,
      predictedPeakDb: -6,
      peakLimited: false,
      boostCapped: false,
      gainClamped: false,
      willClip: false,
      estimated: false,
      unmeasured: false,
    },
    soundGainDb: 0,
    padGainDb: 0,
    ...overrides,
  };
}

describe("buildSoundRows", () => {
  it("produces one row per pad-sound pair", () => {
    const rows = buildSoundRows([pad({ audioFileIds: [10, 11] })], options);
    expect(rows).toHaveLength(2);
    expect(rows[0].audioFileId).toBe(10);
    expect(rows[1].audioFileId).toBe(11);
  });

  it("skips pads with no sounds", () => {
    expect(buildSoundRows([pad({ audioFileIds: [] })], options)).toHaveLength(
      0,
    );
  });

  it("carries both manual gains onto the row", () => {
    const rows = buildSoundRows(
      [pad({ audioGainSettings: { 10: 4 }, padGainDb: -2 })],
      options,
    );
    expect(rows[0].soundGainDb).toBe(4);
    expect(rows[0].padGainDb).toBe(-2);
  });
});

describe("sortRows", () => {
  it("sorts by deviation from target descending by default", () => {
    const rows = [
      row({ key: "a", gain: { ...row({}).gain, finalLufs: -16 } }),
      row({ key: "b", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    const sorted = sortRows(rows, "deviation", "desc", -16);
    expect(sorted[0].key).toBe("b");
  });

  it("reverses on ascending", () => {
    const rows = [
      row({ key: "a", gain: { ...row({}).gain, finalLufs: -16 } }),
      row({ key: "b", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    expect(sortRows(rows, "deviation", "asc", -16)[0].key).toBe("a");
  });

  // Unmeasurable rows must not silently sort to the top and look like
  // the worst offenders.
  it("sorts null-loudness rows last regardless of direction", () => {
    const rows = [
      row({ key: "null", gain: { ...row({}).gain, finalLufs: null } }),
      row({ key: "real", gain: { ...row({}).gain, finalLufs: -25 } }),
    ];
    expect(sortRows(rows, "deviation", "desc", -16)[1].key).toBe("null");
    expect(sortRows(rows, "deviation", "asc", -16)[1].key).toBe("null");
  });

  it("sorts by sound name", () => {
    const rows = [
      row({ key: "b", soundName: "zebra" }),
      row({ key: "a", soundName: "apple" }),
    ];
    expect(sortRows(rows, "soundName", "asc", -16)[0].soundName).toBe("apple");
  });
});

describe("filterProblemRows", () => {
  it("keeps clipping rows", () => {
    const rows = [
      row({ key: "ok" }),
      row({ key: "clip", gain: { ...row({}).gain, willClip: true } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["clip"]);
  });

  it("keeps peak-limited rows", () => {
    const rows = [
      row({ key: "ok" }),
      row({ key: "limited", gain: { ...row({}).gain, peakLimited: true } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["limited"]);
  });

  it("keeps rows more than 3 dB off target", () => {
    const rows = [
      row({ key: "ok", gain: { ...row({}).gain, finalLufs: -17 } }),
      row({ key: "off", gain: { ...row({}).gain, finalLufs: -22 } }),
    ];
    expect(filterProblemRows(rows, -16).map((r) => r.key)).toEqual(["off"]);
  });

  it("keeps unmeasured rows out of the problem list", () => {
    const rows = [
      row({
        key: "pending",
        gain: { ...row({}).gain, unmeasured: true, finalLufs: null },
      }),
    ];
    expect(filterProblemRows(rows, -16)).toHaveLength(0);
  });
});

describe("buildPadRows", () => {
  it("aggregates the spread across a pad's sounds", () => {
    const rows = [
      row({
        key: "a",
        audioFileId: 10,
        gain: { ...row({}).gain, finalLufs: -20 },
      }),
      row({
        key: "b",
        audioFileId: 11,
        gain: { ...row({}).gain, finalLufs: -14 },
      }),
    ];
    const padRows = buildPadRows(rows);
    expect(padRows).toHaveLength(1);
    expect(padRows[0].minLufs).toBeCloseTo(-20, 1);
    expect(padRows[0].maxLufs).toBeCloseTo(-14, 1);
    expect(padRows[0].spreadDb).toBeCloseTo(6, 1);
    expect(padRows[0].soundCount).toBe(2);
  });

  it("reports a null spread when nothing is measurable", () => {
    const padRows = buildPadRows([
      row({ gain: { ...row({}).gain, finalLufs: null } }),
    ]);
    expect(padRows[0].spreadDb).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/audio/loudness/overview.test.ts`
Expected: FAIL — `Failed to resolve import "./overview"`.

- [ ] **Step 3: Implement the row builders**

Create `src/lib/audio/loudness/overview.ts`:

```ts
/**
 * Audio Module - Loudness overview rows
 *
 * Builds the rows behind the loudness overview table. Every level comes from
 * resolveGain — the same function the playback path calls — so the table can
 * never disagree with what is actually heard.
 *
 * @module lib/audio/loudness/overview
 */

import type { LoudnessAnalysis, PadConfiguration } from "@/lib/db";
import { resolveGain } from "./gain";
import type { NormalisationSettings, ResolvedGain } from "./types";

/** How far off target a row must be to count as a problem, dB. */
const PROBLEM_DEVIATION_DB = 3;

export interface SoundRow {
  key: string;
  pageIndex: number;
  padIndex: number;
  bankName: string;
  padName: string;
  audioFileId: number;
  soundName: string;
  gain: ResolvedGain;
  soundGainDb: number;
  padGainDb: number;
}

export interface PadRow {
  key: string;
  pageIndex: number;
  padIndex: number;
  bankName: string;
  padName: string;
  soundCount: number;
  minLufs: number | null;
  maxLufs: number | null;
  /** max - min across the pad's measurable sounds. null when none are. */
  spreadDb: number | null;
}

export interface BuildRowsOptions {
  normalisation: NormalisationSettings;
  getAnalysis: (audioFileId: number) => LoudnessAnalysis | undefined;
  getSoundName: (audioFileId: number) => string;
  getBankName: (pageIndex: number) => string;
}

export function buildSoundRows(
  pads: PadConfiguration[],
  options: BuildRowsOptions,
): SoundRow[] {
  const rows: SoundRow[] = [];

  for (const pad of pads) {
    for (const audioFileId of pad.audioFileIds ?? []) {
      const trim = pad.audioTrimSettings?.[audioFileId];
      const soundGainDb = pad.audioGainSettings?.[audioFileId] ?? 0;
      const padGainDb = pad.padGainDb ?? 0;

      rows.push({
        key: `${pad.pageIndex}-${pad.padIndex}-${audioFileId}`,
        pageIndex: pad.pageIndex,
        padIndex: pad.padIndex,
        bankName: options.getBankName(pad.pageIndex),
        padName: pad.name ?? `Pad ${pad.padIndex + 1}`,
        audioFileId,
        soundName: options.getSoundName(audioFileId),
        gain: resolveGain({
          analysis: options.getAnalysis(audioFileId),
          trimStart: trim?.trimStart ?? 0,
          trimEnd: trim?.trimEnd,
          soundGainDb,
          padGainDb,
          normalisation: options.normalisation,
        }),
        soundGainDb,
        padGainDb,
      });
    }
  }

  return rows;
}

export function buildPadRows(soundRows: SoundRow[]): PadRow[] {
  const byPad = new Map<string, SoundRow[]>();

  for (const row of soundRows) {
    const key = `${row.pageIndex}-${row.padIndex}`;
    const existing = byPad.get(key);
    if (existing) existing.push(row);
    else byPad.set(key, [row]);
  }

  const padRows: PadRow[] = [];

  for (const [key, rows] of byPad) {
    const levels = rows
      .map((r) => r.gain.finalLufs)
      .filter((v): v is number => v !== null);

    padRows.push({
      key,
      pageIndex: rows[0].pageIndex,
      padIndex: rows[0].padIndex,
      bankName: rows[0].bankName,
      padName: rows[0].padName,
      soundCount: rows.length,
      minLufs: levels.length ? Math.min(...levels) : null,
      maxLufs: levels.length ? Math.max(...levels) : null,
      spreadDb: levels.length
        ? Math.max(...levels) - Math.min(...levels)
        : null,
    });
  }

  return padRows;
}

export type SoundSortKey =
  | "bank"
  | "soundName"
  | "measured"
  | "norm"
  | "soundGain"
  | "padGain"
  | "final"
  | "deviation";

export type SortDirection = "asc" | "desc";

function sortValue(
  row: SoundRow,
  key: SoundSortKey,
  target: number,
): number | string | null {
  switch (key) {
    case "bank":
      return row.pageIndex * 1000 + row.padIndex;
    case "soundName":
      return row.soundName.toLowerCase();
    case "measured":
      return row.gain.measuredLufs;
    case "norm":
      return row.gain.normDb;
    case "soundGain":
      return row.soundGainDb;
    case "padGain":
      return row.padGainDb;
    case "final":
      return row.gain.finalLufs;
    case "deviation":
      return row.gain.finalLufs === null
        ? null
        : Math.abs(row.gain.finalLufs - target);
  }
}

/**
 * Sorts rows, always pushing unmeasurable rows to the end.
 *
 * Without that, a row with no measurement would sort as if it were zero and
 * appear among the worst offenders, which is misleading.
 */
export function sortRows(
  rows: SoundRow[],
  key: SoundSortKey,
  direction: SortDirection,
  target: number,
): SoundRow[] {
  const factor = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = sortValue(a, key, target);
    const bv = sortValue(b, key, target);

    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;

    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * factor;
    }
    return ((av as number) - (bv as number)) * factor;
  });
}

/**
 * Keeps only rows worth acting on: clipping, peak-limited, or well off target.
 * Rows that are merely not analysed yet are not problems.
 */
export function filterProblemRows(
  rows: SoundRow[],
  target: number,
): SoundRow[] {
  return rows.filter((row) => {
    if (row.gain.unmeasured) return false;
    if (row.gain.willClip || row.gain.peakLimited || row.gain.gainClamped) {
      return true;
    }
    if (row.gain.finalLufs === null) return false;
    return Math.abs(row.gain.finalLufs - target) > PROBLEM_DEVIATION_DB;
  });
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/lib/audio/loudness/overview.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Register the modal**

In `src/components/modals/modalRegistry.ts`, add to the enum:

```ts
  LOUDNESS_OVERVIEW = "loudnessOverview",
```

and to `modalComponents`:

```ts
  [ModalType.LOUDNESS_OVERVIEW]: lazy(
    () => import("./LoudnessOverviewModalContent"),
  ),
```

- [ ] **Step 6: Commit the row layer**

```bash
git add src/lib/audio/loudness/overview.ts src/lib/audio/loudness/overview.test.ts src/components/modals/modalRegistry.ts
git commit -m "feat(loudness): overview row building, sorting and problem filter"
```

---

### Task 16: Loudness overview modal

**Files:**

- Create: `src/components/modals/LoudnessOverviewModalContent.tsx`
- Modify: wherever the app's menu lives, to add an entry that opens the modal

**Interfaces:**

- Consumes: everything from Task 15, plus `formatGainDb` / `formatLufs` / `gainToneClass`.
- Produces: the modal component as a default export.

**Background the implementer needs:** Load the `dataviz` skill before choosing the accent colours, so the boost/cut/warning palette is a coherent, contrast-checked set in both themes rather than picked ad hoc. Colour is decoration: every gain cell renders its signed number and both warning states render text.

- [ ] **Step 1: Build the modal**

Create `src/components/modals/LoudnessOverviewModalContent.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { getCachedLoudness } from "@/lib/audio/loudness/cache";
import {
  formatGainDb,
  formatLufs,
  gainToneClass,
} from "@/lib/audio/loudness/format";
import {
  buildPadRows,
  buildSoundRows,
  filterProblemRows,
  sortRows,
  type SortDirection,
  type SoundSortKey,
} from "@/lib/audio/loudness/overview";
import { DEFAULT_NORMALISATION } from "@/lib/audio/loudness/types";
import {
  getAllPadConfigurationsForProfile,
  getAudioFile,
  updatePadConfiguration,
  type PadConfiguration,
} from "@/lib/db";
import { useProfileStore } from "@/store/profileStore";

const COLUMNS: { key: SoundSortKey; label: string }[] = [
  { key: "bank", label: "Bank · Pad" },
  { key: "soundName", label: "Sound" },
  { key: "measured", label: "Measured" },
  { key: "norm", label: "Norm" },
  { key: "soundGain", label: "Sound gain" },
  { key: "padGain", label: "Pad gain" },
  { key: "final", label: "Final" },
  { key: "deviation", label: "Δ target" },
];

export default function LoudnessOverviewModalContent() {
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const normalisation =
    useProfileStore((s) => s.profiles.find((p) => p.id === s.activeProfileId))
      ?.normalisation ?? DEFAULT_NORMALISATION;

  const [pads, setPads] = useState<PadConfiguration[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [tab, setTab] = useState<"sounds" | "pads">("sounds");
  const [sortKey, setSortKey] = useState<SoundSortKey>("deviation");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [problemsOnly, setProblemsOnly] = useState(false);

  useEffect(() => {
    if (activeProfileId === null) return;
    let cancelled = false;

    void (async () => {
      const loaded = await getAllPadConfigurationsForProfile(activeProfileId);
      if (cancelled) return;
      setPads(loaded);

      const nameMap = new Map<number, string>();
      for (const pad of loaded) {
        for (const id of pad.audioFileIds ?? []) {
          if (!nameMap.has(id)) {
            const file = await getAudioFile(id);
            nameMap.set(id, file?.name ?? `Sound ${id}`);
          }
        }
      }
      if (!cancelled) setNames(nameMap);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  const soundRows = useMemo(
    () =>
      buildSoundRows(pads, {
        normalisation,
        getAnalysis: getCachedLoudness,
        getSoundName: (id) => names.get(id) ?? `Sound ${id}`,
        getBankName: (pageIndex) => `Bank ${pageIndex + 1}`,
      }),
    [pads, normalisation, names],
  );

  const visibleRows = useMemo(() => {
    const filtered = problemsOnly
      ? filterProblemRows(soundRows, normalisation.targetLufs)
      : soundRows;
    return sortRows(filtered, sortKey, direction, normalisation.targetLufs);
  }, [soundRows, problemsOnly, sortKey, direction, normalisation.targetLufs]);

  const padRows = useMemo(() => buildPadRows(soundRows), [soundRows]);

  const toggleSort = (key: SoundSortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection("desc");
    }
  };

  const setSoundGain = async (
    pageIndex: number,
    padIndex: number,
    audioFileId: number,
    db: number,
  ) => {
    const pad = pads.find(
      (p) => p.pageIndex === pageIndex && p.padIndex === padIndex,
    );
    if (!pad || activeProfileId === null) return;

    const updated = {
      ...(pad.audioGainSettings ?? {}),
      [audioFileId]: db,
    };
    await updatePadConfiguration({ ...pad, audioGainSettings: updated });
    setPads((current) =>
      current.map((p) =>
        p.pageIndex === pageIndex && p.padIndex === padIndex
          ? { ...p, audioGainSettings: updated }
          : p,
      ),
    );
  };

  return (
    <div className="flex max-h-[70vh] flex-col" data-testid="loudness-overview">
      <div className="mb-3 flex items-center gap-4">
        <div className="flex gap-1" role="tablist">
          {(["sounds", "pads"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-sm capitalize ${
                tab === t
                  ? "bg-gray-200 font-medium dark:bg-gray-700"
                  : "text-gray-600 dark:text-gray-400"
              }`}
              data-testid={`loudness-tab-${t}`}
            >
              {t}
            </button>
          ))}
        </div>

        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={(e) => setProblemsOnly(e.target.checked)}
            data-testid="loudness-problems-only"
          />
          Problems only
        </label>
      </div>

      <div className="overflow-auto">
        {tab === "sounds" ? (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-2 py-1">
                    <button
                      onClick={() => toggleSort(col.key)}
                      className="font-medium hover:underline"
                      aria-label={`Sort by ${col.label}`}
                      data-testid={`loudness-sort-${col.key}`}
                    >
                      {col.label}
                      {sortKey === col.key &&
                        (direction === "asc" ? " ↑" : " ↓")}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-gray-100 dark:border-gray-700"
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    {row.bankName} · {row.padIndex + 1}
                  </td>
                  <td className="px-2 py-1">{row.soundName}</td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatLufs(row.gain.measuredLufs)}
                    {row.gain.estimated && (
                      <span className="ml-1 text-xs text-gray-500">est</span>
                    )}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatGainDb(row.gain.normDb)}
                    {row.gain.peakLimited && (
                      <span
                        className="ml-1 text-amber-700 dark:text-amber-300"
                        title="Limited by peak ceiling"
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      step={0.5}
                      value={row.soundGainDb}
                      onChange={(e) =>
                        void setSoundGain(
                          row.pageIndex,
                          row.padIndex,
                          row.audioFileId,
                          Number(e.target.value),
                        )
                      }
                      aria-label={`Sound gain for ${row.soundName}`}
                      className={`w-16 rounded border border-gray-300 bg-transparent px-1 font-mono tabular-nums dark:border-gray-600 ${gainToneClass(row.soundGainDb)}`}
                      data-testid={`loudness-sound-gain-${row.key}`}
                    />
                  </td>
                  <td
                    className={`px-2 py-1 font-mono tabular-nums ${gainToneClass(row.padGainDb)}`}
                  >
                    {formatGainDb(row.padGainDb)}
                  </td>
                  <td className="px-2 py-1 font-mono font-medium tabular-nums">
                    {formatLufs(row.gain.finalLufs)}
                  </td>
                  <td className="px-2 py-1">
                    {row.gain.willClip ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200">
                        ⚠ clips by {formatGainDb(row.gain.predictedPeakDb)} dB
                      </span>
                    ) : row.gain.unmeasured ? (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        analysing…
                      </span>
                    ) : row.gain.finalLufs === null ? (
                      "—"
                    ) : (
                      <span className="font-mono tabular-nums">
                        {formatGainDb(
                          row.gain.finalLufs - normalisation.targetLufs,
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr>
                <th className="px-2 py-1">Bank · Pad</th>
                <th className="px-2 py-1">Name</th>
                <th className="px-2 py-1">Sounds</th>
                <th className="px-2 py-1">Quietest</th>
                <th className="px-2 py-1">Loudest</th>
                <th className="px-2 py-1">Spread</th>
              </tr>
            </thead>
            <tbody>
              {padRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-gray-100 dark:border-gray-700"
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    {row.bankName} · {row.padIndex + 1}
                  </td>
                  <td className="px-2 py-1">{row.padName}</td>
                  <td className="px-2 py-1 tabular-nums">{row.soundCount}</td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatLufs(row.minLufs)}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatLufs(row.maxLufs)}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {row.spreadDb === null ? "—" : formatGainDb(row.spreadDb)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {visibleRows.length === 0 && tab === "sounds" && (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {problemsOnly
            ? "No problems found — every sound is within 3 dB of target."
            : "No sounds assigned yet."}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add a menu entry that opens it**

Wherever the app exposes profile-level actions, add a button calling:

```ts
openModal({
  modalType: ModalType.LOUDNESS_OVERVIEW,
  title: "Loudness overview",
});
```

Match the surrounding call signature — check how `ModalType.HELP` is opened and mirror it exactly.

- [ ] **Step 3: Verify in the running app**

Open the overview on a profile with several sounds. Confirm: both tabs render; clicking a column header sorts and clicking again reverses; the problems filter narrows the list; editing a sound gain cell updates the Final column immediately and persists across a reload.

- [ ] **Step 4: Type check, lint, test and commit**

```bash
npx tsc --noEmit && npm run lint && npm test
git add src/components/modals/LoudnessOverviewModalContent.tsx
git commit -m "feat(loudness): sortable loudness overview modal"
```

---

## Phase 6 — Export, docs and E2E

### Task 17: Export and import the analysis

**Files:**

- Modify: `src/lib/importExport.ts`
- Test: `src/lib/importExport.loudness.test.ts`

**Interfaces:**

- Produces: `serialiseLoudness(analysis)`, `deserialiseLoudness(serialised)`.

**Background the implementer needs:** Exports are ZIP archives carrying the audio itself, so a few KB of manifest per file is negligible against the payload and it saves the importing device a full re-analysis pass. Typed arrays are not JSON, so they are base64-encoded. An analysis whose `algoVersion` does not match the current constant is dropped on import and the file is queued for backfill instead — importing a stale measurement would produce confidently wrong levels.

- [ ] **Step 1: Write the failing test**

Create `src/lib/importExport.loudness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { LoudnessAnalysis } from "./db";
import { deserialiseLoudness, serialiseLoudness } from "./importExport";
import { LOUDNESS_ALGO_VERSION } from "./audio/loudness/constants";

function analysis(): LoudnessAnalysis {
  return {
    algoVersion: LOUDNESS_ALGO_VERSION,
    sampleRate: 48000,
    duration: 1.5,
    blockMeanSquare: Float32Array.from([0.001, 0.002, 0.003]),
    hopTruePeak: Float32Array.from([0.5, 0.6]),
  };
}

describe("loudness serialisation", () => {
  it("round-trips an analysis", () => {
    const restored = deserialiseLoudness(serialiseLoudness(analysis()));
    expect(restored).not.toBeNull();
    expect(restored?.sampleRate).toBe(48000);
    expect(restored?.duration).toBeCloseTo(1.5, 5);
    expect(Array.from(restored?.blockMeanSquare ?? [])).toEqual([
      expect.closeTo(0.001, 6),
      expect.closeTo(0.002, 6),
      expect.closeTo(0.003, 6),
    ]);
    expect(restored?.hopTruePeak.length).toBe(2);
  });

  // A stale measurement would produce confidently wrong levels, which is
  // worse than no measurement at all.
  it("drops an analysis from a different algorithm version", () => {
    const serialised = serialiseLoudness({
      ...analysis(),
      algoVersion: LOUDNESS_ALGO_VERSION + 1,
    });
    expect(deserialiseLoudness(serialised)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(deserialiseLoudness(undefined)).toBeNull();
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(
      deserialiseLoudness({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: "not base64!!!",
        hopTruePeak: "also not",
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/importExport.loudness.test.ts`
Expected: FAIL — `serialiseLoudness` is not exported.

- [ ] **Step 3: Implement serialisation**

Add to `src/lib/importExport.ts`:

```ts
import type { LoudnessAnalysis } from "./db";
import { LOUDNESS_ALGO_VERSION } from "./audio/loudness/constants";

export interface SerialisedLoudness {
  algoVersion: number;
  sampleRate: number;
  duration: number;
  /** base64 of the Float32Array buffer. */
  blockMeanSquare: string;
  /** base64 of the Float32Array buffer. */
  hopTruePeak: string;
}

function floatsToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToFloats(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function serialiseLoudness(
  analysis: LoudnessAnalysis,
): SerialisedLoudness {
  return {
    algoVersion: analysis.algoVersion,
    sampleRate: analysis.sampleRate,
    duration: analysis.duration,
    blockMeanSquare: floatsToBase64(analysis.blockMeanSquare),
    hopTruePeak: floatsToBase64(analysis.hopTruePeak),
  };
}

/**
 * Restores an exported analysis.
 *
 * Returns null when the analysis came from a different algorithm version or
 * cannot be decoded — the file is then queued for local backfill. Accepting a
 * stale measurement would produce confidently wrong levels, which is worse
 * than having none.
 */
export function deserialiseLoudness(
  serialised: SerialisedLoudness | undefined,
): LoudnessAnalysis | null {
  if (!serialised) return null;
  if (serialised.algoVersion !== LOUDNESS_ALGO_VERSION) return null;

  try {
    return {
      algoVersion: serialised.algoVersion,
      sampleRate: serialised.sampleRate,
      duration: serialised.duration,
      blockMeanSquare: base64ToFloats(serialised.blockMeanSquare),
      hopTruePeak: base64ToFloats(serialised.hopTruePeak),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire it into the export and import paths**

Where audio file metadata is written to the export manifest, add `loudness: file.loudness ? serialiseLoudness(file.loudness) : undefined`. Where audio files are created on import, add `loudness: deserialiseLoudness(exported.loudness) ?? undefined`.

- [ ] **Step 5: Run the test and the suite**

Run: `npx vitest run src/lib/importExport.loudness.test.ts && npm test && npx tsc --noEmit`
Expected: PASS, 4 new tests, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/importExport.ts src/lib/importExport.loudness.test.ts
git commit -m "feat(loudness): carry analysis through export and import"
```

---

### Task 18: End-to-end tests

**Files:**

- Create: `e2e-tests/loudness.spec.ts`
- Modify: `package.json` (add `test:e2e:loudness`)

**Background the implementer needs:** Chromium only. Resolved gain is not visible in the DOM, so the audio-path assertions read `window.__impampLastResolvedGain`, exposed in Task 10. Reuse the helpers in `e2e-tests/test-helpers.ts` for profile setup and pad assignment rather than writing new ones.

- [ ] **Step 1: Write the spec**

Create `e2e-tests/loudness.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe("loudness normalisation", () => {
  test("opens the overview and filters to problems", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("loudness-overview-open").click();

    await expect(page.getByTestId("loudness-overview")).toBeVisible();

    await page.getByTestId("loudness-tab-pads").click();
    await expect(page.getByRole("tab", { name: "pads" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.getByTestId("loudness-tab-sounds").click();
    await page.getByTestId("loudness-sort-final").click();
    await page.getByTestId("loudness-problems-only").check();
    await expect(page.getByTestId("loudness-problems-only")).toBeChecked();
  });

  test("per-sound gain persists and reaches the audio path", async ({
    page,
  }) => {
    await page.goto("/");
    // Assign a sound to pad 0 using the shared helper, then open its editor.
    // See e2e-tests/test-helpers.ts for the assignment helper this reuses.

    await page.keyboard.down("Shift");
    await page.getByTestId("pad-0").click();
    await page.keyboard.up("Shift");

    const slider = page.getByTestId(/^edit-pad-gain-sound-/).first();
    await slider.fill("6");
    await page.getByRole("button", { name: /save/i }).click();

    await page.getByTestId("pad-0").click();

    const resolved = await page.evaluate(
      () =>
        (
          window as unknown as {
            __impampLastResolvedGain?: { totalDb: number };
          }
        ).__impampLastResolvedGain,
    );

    expect(resolved).toBeTruthy();
    expect(resolved!.totalDb).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 2: Add the script to `package.json`**

```json
    "test:e2e:loudness": "playwright test e2e-tests/loudness.spec.ts --project=chromium",
```

- [ ] **Step 3: Run it**

Run: `npm run test:e2e:loudness`
Expected: both tests pass on chromium.

If the pad assignment helper differs from the sketch above, adapt to whatever `e2e-tests/test-helpers.ts` actually provides — do not add a second assignment helper.

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/loudness.spec.ts package.json
git commit -m "test(loudness): e2e coverage for gain and the overview"
```

---

### Task 19: Documentation

**Files:**

- Create: `docs/loudness-normalisation.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the feature doc**

Create `docs/loudness-normalisation.md` covering: what normalisation does and does not do; the three gain stages and how they multiply; why analysis is stored as block mean squares rather than a single number; the peak ceiling and what "peak limited" means for the user; what the clip warning does and does not cover (single sounds yes, several pads summing no); and where the backfill progress appears.

- [ ] **Step 2: Update `CLAUDE.md`**

Under **Key Features Implementation**:

```markdown
- **Loudness normalisation** - every audio file is analysed once for
  BS.1770-4 loudness, stored as per-block mean squares so any trimmed
  sub-range can be measured exactly without re-decoding. Gain resolves as
  normalisation x per-sound gain x per-pad gain into `PlayAudioParams.volume`.
  `src/lib/audio/loudness/`. See `docs/loudness-normalisation.md`.
```

Under **Important Implementation Notes**:

```markdown
- All level arithmetic lives in `src/lib/audio/loudness/gain.ts`. The overview
  table and the playback path both call `resolveGain`; a second implementation
  would let the table disagree with what is heard
- `audioGainSettings` is keyed by audio file ID, and those IDs are remapped on
  import and sync in three places — `importExport.ts`, `googleDrive/dataAccess.ts`
  and `syncUtils.ts`. Any new `Record<audioFileId, …>` field must be remapped in
  all three or it silently attaches to the wrong sounds
- Gain resolution at trigger time is synchronous on purpose. The analysis cache
  is warmed on profile activation so the playback path never awaits a DB read
```

- [ ] **Step 3: Commit**

```bash
git add docs/loudness-normalisation.md CLAUDE.md
git commit -m "docs: loudness normalisation and gain control"
```

---

## Self-review notes

Checked against the spec; the following were verified present:

- Per-block storage, range queries, and the range-equivalence property → Tasks 3, 4.
- All three gain stages, three separate limits, and reporting from applied gain → Task 5.
- Trim-aware normalisation → Tasks 4, 5, 14.
- Clip prediction from oversampled true peak → Tasks 2, 5.
- Short-clip (<400 ms) fallback → Tasks 3, 4.
- Per-rate coefficient derivation → Task 1.
- The three ID-remapping sites → Task 8.
- `PadPlaybackSettings` refactor → Tasks 6, 7.
- Backfill on idle, non-blocking, graceful degradation → Task 11.
- Sortable columns, problems filter, inline editing, null rows last → Tasks 15, 16.
- Colour marking with the number always rendered → Tasks 13, 16.
- E2E hook for resolved gain → Task 10, used in Task 18.

**Deliberately deferred** (spec's Out of Scope): sum-clip detection across simultaneous pads, limiting/compression, cross-profile matching, momentary/short-term display.

**Known risk in execution order:** Task 8 (ID remapping) is the one place where
a mistake is silent — gains land on the wrong sounds with no error. Its four
tests plus the count-comparison check in Task 7 Step 4 are the guard. Do not
skip either.
