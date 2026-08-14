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
