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
    const original = analysis();
    const restored = deserialiseLoudness(serialiseLoudness(original));
    expect(restored).not.toBeNull();
    expect(restored?.sampleRate).toBe(48000);
    expect(restored?.duration).toBe(1.5);
    // Compare against the source Float32Array's own values, not decimal
    // literals: constructing a Float32Array from [0.001, 0.002, 0.003]
    // already rounds to the nearest float32, so the literals themselves are
    // not exactly representable and would make this assertion fail even on
    // a perfectly bit-exact round trip. The property under test is that
    // serialise/deserialise loses nothing beyond that unavoidable rounding.
    expect(Array.from(restored?.blockMeanSquare ?? [])).toEqual(
      Array.from(original.blockMeanSquare),
    );
    expect(Array.from(restored?.hopTruePeak ?? [])).toEqual(
      Array.from(original.hopTruePeak),
    );
  });

  /**
   * Arrays that are views into a bigger buffer.
   *
   * `floatsToBase64` respects `byteOffset` and `byteLength` rather than
   * encoding `values.buffer` whole, and its comment says why — but every
   * fixture in this file is an exact-size `Float32Array.from(...)`, whose
   * offset is 0 and whose length is its buffer's, so the branch had never run.
   * A `subarray` is what a slice of a longer analysis actually is, and
   * encoding the whole backing store would silently export a neighbour's
   * numbers under this sound's name.
   */
  it("round-trips arrays that are views into a larger buffer", () => {
    const backing = Float32Array.from([9, 9, 0.001, 0.002, 0.003, 9]);
    const view = backing.subarray(2, 5);
    expect(view.byteOffset).toBeGreaterThan(0);

    const restored = deserialiseLoudness(
      serialiseLoudness({ ...analysis(), blockMeanSquare: view }),
    );

    expect(Array.from(restored?.blockMeanSquare ?? [])).toEqual(
      Array.from(view),
    );
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

  // Valid base64 that decodes to a byte length not divisible by 4 (e.g. a
  // truncated or padded payload) makes `new Float32Array(bytes.buffer)`
  // throw RangeError — a decode-failure path distinct from invalid base64
  // characters, and specific to typed-array reconstruction.
  it("returns null when the decoded byte length is not a multiple of 4", () => {
    expect(
      deserialiseLoudness({
        algoVersion: LOUDNESS_ALGO_VERSION,
        sampleRate: 48000,
        duration: 1,
        blockMeanSquare: btoa("abc"), // 3 bytes, not a multiple of 4
        hopTruePeak: btoa("abcd"), // valid, 4 bytes
      }),
    ).toBeNull();
  });
});
