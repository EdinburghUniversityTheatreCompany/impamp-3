/**
 * Audio Module - Loudness types
 *
 * @module lib/audio/loudness/types
 */

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

/** Loudness and peak over one region of a file. */
export interface RangeLoudness {
  /** Integrated loudness over the range, LUFS. null when silent or unmeasurable. */
  lufs: number | null;
  /** True peak over the range, dBTP. -Infinity for digital silence. */
  truePeakDb: number;
  /** True when derived from a partial block (range shorter than 400 ms). */
  estimated: boolean;
}

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
  analysis: LoudnessAnalysis | undefined;
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
