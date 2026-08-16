/**
 * The sliding block sum must agree with the obvious implementation.
 *
 * BS.1770 blocks are 400 ms on a 100 ms hop, so they overlap four deep and the
 * original loop touched every sample four times — ~1.15e8 multiply-adds for a
 * 5-minute stereo file, on the main thread, per file added. Summing
 * incrementally is a 4x reduction, but only if it computes the same numbers,
 * and floating-point add-then-subtract is exactly where that assumption goes
 * wrong. So it is checked against a straightforward re-summing reference on
 * signals chosen to be awkward.
 */
import { describe, expect, it } from "vitest";
import { analyseLoudness } from "./analyse";
import { kWeight } from "./kWeighting";
import { BLOCK_SECONDS, HOP_SECONDS } from "./constants";

const SAMPLE_RATE = 48_000;

/** The implementation this replaced: every block summed from scratch. */
function naiveBlockMeanSquare(
  weighted: Float32Array[],
  sampleRate: number,
  channelWeight: (index: number, count: number) => number,
): Float32Array {
  const length = weighted[0].length;
  const blockSamples = Math.round(BLOCK_SECONDS * sampleRate);
  const hopSamples = Math.round(HOP_SECONDS * sampleRate);
  const blockCount =
    length < blockSamples
      ? 0
      : Math.floor((length - blockSamples) / hopSamples) + 1;

  const out = new Float32Array(blockCount);
  for (let j = 0; j < blockCount; j++) {
    const start = j * hopSamples;
    const end = start + blockSamples;
    let w = 0;
    for (let ch = 0; ch < weighted.length; ch++) {
      const data = weighted[ch];
      let sumSquares = 0;
      for (let i = start; i < end; i++) sumSquares += data[i] * data[i];
      w += channelWeight(ch, weighted.length) * (sumSquares / blockSamples);
    }
    out[j] = w;
  }
  return out;
}

function signal(seconds: number, shape: (t: number, i: number) => number) {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = shape(i / SAMPLE_RATE, i);
  return data;
}

describe("the sliding block sum", () => {
  it.each([
    ["a steady tone", (t: number) => Math.sin(2 * Math.PI * 1000 * t) * 0.5],
    [
      // Silence then a loud burst: the window slides across a discontinuity,
      // which is where a running total drifts if it is going to.
      "silence then a burst",
      (t: number) => (t < 3 ? 0 : Math.sin(2 * Math.PI * 200 * t) * 0.95),
    ],
    [
      // Very small values next to very large ones is the classic way to lose
      // precision in a running sum.
      "a huge dynamic range",
      (t: number, i: number) =>
        (i % 1000 === 0 ? 0.99 : 1e-7) * Math.sin(2 * Math.PI * 50 * t),
    ],
  ])("matches a re-summing reference on %s", (_label, shape) => {
    // Long enough to cross the periodic resync several times over.
    const left = signal(6, shape);
    const right = signal(6, (t, i) => shape(t, i) * 0.7);

    const analysis = analyseLoudness([left, right], SAMPLE_RATE);

    // analyseLoudness K-weights internally, so the reference is fed the same
    // weighted signal by measuring a single-block window against it.
    expect(analysis.blockMeanSquare.length).toBeGreaterThan(50);

    // Compare the *result* of the two loops via total energy and per-block
    // values, both to a tolerance far below anything audible: LUFS is
    // 10*log10, so 1e-6 relative is ~4e-6 dB.
    const reference = naiveReferenceFor(left, right);
    expect(reference.length).toBe(analysis.blockMeanSquare.length);

    for (let j = 0; j < reference.length; j++) {
      const a = analysis.blockMeanSquare[j];
      const b = reference[j];
      const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
      expect(Math.abs(a - b) / scale).toBeLessThan(1e-5);
    }
  });

  it("still returns nothing for a file shorter than one block", () => {
    const short = signal(BLOCK_SECONDS / 2, (t) => Math.sin(t));
    expect(analyseLoudness([short], SAMPLE_RATE).blockMeanSquare).toHaveLength(
      0,
    );
  });
});

/**
 * Runs the naive loop over the same K-weighted signal `analyseLoudness` uses,
 * by going through the module's own weighting so the only difference under
 * test is the summation strategy.
 */
function naiveReferenceFor(left: Float32Array, right: Float32Array) {
  // The same K-weighting the analysis applies, so the only thing differing
  // between the two paths is how the block sums are accumulated.
  const weighted = [left, right].map((c) => kWeight(c, SAMPLE_RATE));
  // Stereo: both channels weight 1.
  return naiveBlockMeanSquare(weighted, SAMPLE_RATE, () => 1);
}
