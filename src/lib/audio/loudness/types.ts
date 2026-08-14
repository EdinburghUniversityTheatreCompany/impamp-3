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
