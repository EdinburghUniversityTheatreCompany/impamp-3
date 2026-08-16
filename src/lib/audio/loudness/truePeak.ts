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
        const raw = channel[i] < 0 ? -channel[i] : channel[i];
        if (raw > peak) peak = raw;

        const base = i - half + 1;
        // Whether the whole tap window lies inside the signal. Splitting on
        // this is worth the duplication: the bounds test used to run once per
        // tap — 36 branches per sample per channel, and this loop is 93% of
        // the cost of analysing a file. Only the first and last few samples of
        // a file need it.
        const interior = base >= 0 && base + TRUE_PEAK_TAPS_PER_PHASE <= length;

        for (let p = 1; p < TRUE_PEAK_OVERSAMPLE; p++) {
          const taps = POLYPHASE[p];
          let acc = 0;

          if (interior) {
            for (let t = 0; t < TRUE_PEAK_TAPS_PER_PHASE; t++) {
              acc += taps[t] * channel[base + t];
            }
          } else {
            for (let t = 0; t < TRUE_PEAK_TAPS_PER_PHASE; t++) {
              const idx = base + t;
              // Treat out-of-range as silence rather than wrapping.
              if (idx >= 0 && idx < length) acc += taps[t] * channel[idx];
            }
          }

          const mag = acc < 0 ? -acc : acc;
          if (mag > peak) peak = mag;
        }
      }

      peaks[hop] = peak;
    }
  }

  return peaks;
}
