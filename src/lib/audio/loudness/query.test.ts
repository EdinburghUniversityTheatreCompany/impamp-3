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
