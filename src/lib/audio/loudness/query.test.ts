import { describe, expect, it } from "vitest";
import { analyseLoudness } from "./analyse";
import { measureRange } from "./query";
import { concat, sine, TEST_SAMPLE_RATE as SAMPLE_RATE } from "./testFixtures";

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

  // Levels are 8 dB apart on purpose. Widen the gap much further and the
  // relative gate excludes the quiet half outright, collapsing the
  // whole-file figure onto the loud-half one — the gate working, not a bug.
  // The largest gap this comparison can ever show is 10*log10(2) = 3.01 dB.
  it("gives a different answer for a trimmed range than the whole file", () => {
    const full = concat(sine(1000, 4, -28), sine(1000, 4, -20));
    const analysis = analyseLoudness([full, full], SAMPLE_RATE);

    const whole = measureRange(analysis, 0, 8).lufs as number;
    const loudHalf = measureRange(analysis, 4, 8).lufs as number;

    expect(loudHalf).toBeGreaterThan(whole + 2);
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

    // The absolute gate drops the silent blocks; without it this would read
    // about 3 dB low. The residual ~0.2 LU is from the three blocks
    // straddling the tone-to-silence cut, which contain partial tone —
    // inherent to 400 ms block gating, not leakage through the gate.
    expect(padded).toBeCloseTo(toneOnly, 0);
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

  /**
   * The sub-block fallback picks the block that overlaps the range *most*, and
   * until now that was only ever exercised on a constant tone — where every
   * block holds the same level and any choice gives the same answer. Writing
   * `Math.min(end, blockEnd) + Math.max(start, blockStart)` in place of the
   * subtraction survived the whole suite: the sum grows with the block index,
   * so the *last* block always wins.
   *
   * Hence a signal whose end is nothing like its middle. The range sits inside
   * the loud half; the file ends quiet. Choosing by overlap answers -15, and
   * choosing the last block answers about -45.
   */
  it("estimates from the block that overlaps the range, not the last one", () => {
    const loudThenQuiet = concat(sine(1000, 2, -15), sine(1000, 2, -45));
    const analysis = analyseLoudness(
      [loudThenQuiet, loudThenQuiet],
      SAMPLE_RATE,
    );

    // 200 ms, so shorter than a 400 ms gating block, and comfortably inside
    // the loud half.
    const result = measureRange(analysis, 0.5, 0.7);

    expect(result.estimated).toBe(true);
    expect(result.lufs).toBeCloseTo(-15, 0);
  });

  /**
   * A range of exactly one gating block is measured, not estimated.
   *
   * `blockStart >= start && blockStart + BLOCK_SECONDS <= end` is the only
   * place the fully-inside test is made, and both of its `=`s matter at
   * exactly this range: relax either one and no block qualifies, the sub-block
   * fallback runs instead, and a trim that is precisely 400 ms silently
   * becomes an estimate.
   */
  it("measures a range exactly one gating block long", () => {
    const analysis = analyseLoudness(
      [sine(1000, 2, -23), sine(1000, 2, -23)],
      SAMPLE_RATE,
    );

    const result = measureRange(analysis, 0, 0.4);

    expect(result.estimated).toBe(false);
    expect(result.lufs).toBeCloseTo(-23, 1);
  });

  /**
   * Silence shorter than a gating block.
   *
   * The gate on the estimated path is `Number.isFinite(lufs) && lufs >
   * ABSOLUTE_GATE_LUFS`, and it was only ever reached with a signal in it. The
   * finite half is unkillable — `blockLufs(0)` is -Infinity, which the
   * comparison already rejects — so it is defensive, but the branch as a whole
   * decides whether a trimmed-to-silence pad reports a level or admits it has
   * none.
   */
  it("returns null for a sub-block range of digital silence", () => {
    const silence = new Float32Array(SAMPLE_RATE * 2);
    const analysis = analyseLoudness([silence, silence], SAMPLE_RATE);

    const result = measureRange(analysis, 0.5, 0.7);

    expect(result.estimated).toBe(true);
    expect(result.lufs).toBeNull();
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
