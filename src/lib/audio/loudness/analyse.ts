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

import type { LoudnessAnalysis } from "./types";
import { BLOCK_SECONDS, HOP_SECONDS, LOUDNESS_ALGO_VERSION } from "./constants";
import { kWeight } from "./kWeighting";
import { computeHopTruePeak } from "./truePeak";

/**
 * BS.1770-4 channel weights, by channel *role* — not raw index. Web Audio's
 * channel order is only defined for 1 (mono), 2 (stereo), 4 (quad) and 6
 * (5.1); anything else is an unspecified discrete layout, so every channel
 * there is left at unity rather than guessed at.
 *
 *   1 (mono):   [C]                        -> 1
 *   2 (stereo): [L, R]                     -> 1, 1
 *   4 (quad):   [L, R, SL, SR]             -> 1, 1, 1.41, 1.41
 *   6 (5.1):    [L, R, C, LFE, SL, SR]     -> 1, 1, 1, 0, 1.41, 1.41
 *
 * Left, right and centre count at unity; the surrounds (SL/SR) at 1.41. LFE
 * is excluded from the loudness measurement entirely, per BS.1770-4 — it is
 * not a surround channel and must not be weighted as one.
 */
function channelWeight(index: number, channelCount: number): number {
  if (channelCount === 6) {
    if (index === 3) return 0; // LFE — excluded per BS.1770-4
    return index >= 4 ? 1.41 : 1; // SL, SR at 4, 5; L, R, C at 0-2
  }
  if (channelCount === 4) {
    return index >= 2 ? 1.41 : 1; // SL, SR at 2, 3
  }
  return 1; // mono, stereo, and any unspecified discrete layout
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

  // A sliding sum rather than re-summing each block.
  //
  // BS.1770 blocks are 400 ms with a 100 ms hop, so they overlap four deep and
  // re-summing touched every sample four times: for a 5-minute stereo file
  // that is ~1.15e8 multiply-adds where ~2.9e7 will do, all of it blocking the
  // main thread. Each block now adds the samples entering the window and
  // subtracts the ones leaving it.
  //
  // Numerically this is safe to do in a JS number: the operands are Float32,
  // so each square is exactly representable as a double (a 24-bit mantissa
  // squared needs 48 bits, and a double has 53), and the running total is
  // rebuilt from scratch periodically so add/subtract rounding cannot
  // accumulate across a long file.
  const RESYNC_EVERY_BLOCKS = 512;

  for (let ch = 0; ch < weighted.length; ch++) {
    const data = weighted[ch];
    const weight = channelWeight(ch, weighted.length);
    let sumSquares = 0;

    for (let j = 0; j < blockCount; j++) {
      const start = j * hopSamples;
      const end = start + blockSamples;

      if (j === 0 || j % RESYNC_EVERY_BLOCKS === 0) {
        sumSquares = 0;
        for (let i = start; i < end; i++) {
          sumSquares += data[i] * data[i];
        }
      } else {
        // Entering: [end - hopSamples, end). Leaving: [start - hopSamples, start).
        for (let i = end - hopSamples; i < end; i++) {
          sumSquares += data[i] * data[i];
        }
        for (let i = start - hopSamples; i < start; i++) {
          sumSquares -= data[i] * data[i];
        }
      }

      blockMeanSquare[j] += weight * (sumSquares / blockSamples);
    }
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
