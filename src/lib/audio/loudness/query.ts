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

import {
  ABSOLUTE_GATE_LUFS,
  BLOCK_SECONDS,
  HOP_SECONDS,
  LOUDNESS_OFFSET_DB,
  RELATIVE_GATE_LU,
} from "./constants";
import type { LoudnessAnalysis, RangeLoudness } from "./types";

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

  let peakLinear = 0;
  const hopCount = analysis.hopTruePeak.length;
  const firstHop = Math.max(0, Math.floor(start / HOP_SECONDS));
  const lastHop = Math.min(hopCount - 1, Math.ceil(end / HOP_SECONDS) - 1);
  for (let k = firstHop; k <= lastHop; k++) {
    const v = analysis.hopTruePeak[k];
    if (v > peakLinear) peakLinear = v;
  }
  const truePeakDb = peakLinear > 0 ? 20 * Math.log10(peakLinear) : -Infinity;

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

  // Fallback for a range shorter than one gating block: a large share of
  // soundboard content is sub-400 ms stabs, so this path is routine rather
  // than exotic. Use the block that overlaps the range most.
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
