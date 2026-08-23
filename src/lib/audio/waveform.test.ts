/**
 * The waveform downsampler behind the trim editor's canvas.
 *
 * Two things here are easy to get wrong and invisible on screen. The peaks are
 * a *mono* reduction — the average across channels, not channel 0 — so a
 * stereo file whose channels are out of phase must draw as the cancellation it
 * is rather than as one side of it. And a buffer shorter than the requested
 * point count takes a different branch entirely: there is no bucket to reduce,
 * so every sample becomes its own degenerate peak with min === max, and the
 * returned length is the sample count rather than `targetPoints`. A caller
 * that assumed the array is always `targetPoints` long would index off the end
 * of a very short sound.
 */
import { describe, expect, it } from "vitest";
import { getWaveformPeaks } from "./waveform";

/**
 * An AudioBuffer stand-in over plain arrays.
 *
 * `getWaveformPeaks` reads `length`, `numberOfChannels` and `getChannelData`
 * and nothing else, so this is the whole of the surface it touches.
 *
 * @param channels - One array of samples per channel
 * @returns Something structurally sufficient for the downsampler
 */
function bufferOf(channels: number[][]): AudioBuffer {
  return {
    length: channels[0].length,
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => Float32Array.from(channels[channel]),
  } as unknown as AudioBuffer;
}

/** A ramp of `length` samples, so each bucket has a distinguishable content. */
const ramp = (length: number) => Array.from({ length }, (_, i) => i / length);

describe("getWaveformPeaks", () => {
  it("reduces each bucket to its extremes", () => {
    const samples = [0.1, -0.5, 0.9, 0.2, 0.3, -0.7, 0.4, 0.8];

    const peaks = getWaveformPeaks(bufferOf([samples]), 2);

    expect(peaks).toHaveLength(2);
    expect(peaks[0].min).toBeCloseTo(-0.5);
    expect(peaks[0].max).toBeCloseTo(0.9);
    expect(peaks[1].min).toBeCloseTo(-0.7);
    expect(peaks[1].max).toBeCloseTo(0.8);
  });

  it("produces exactly the requested number of points", () => {
    expect(getWaveformPeaks(bufferOf([ramp(4000)]), 50)).toHaveLength(50);
  });

  it("defaults to 800 points", () => {
    expect(getWaveformPeaks(bufferOf([ramp(8000)]))).toHaveLength(800);
  });

  it("averages across channels rather than reading only the first", () => {
    // Perfectly out of phase: the mono reduction is silence, and a
    // channel-0-only implementation would draw a full-scale waveform.
    const peaks = getWaveformPeaks(
      bufferOf([
        [1, -1, 1, -1],
        [-1, 1, -1, 1],
      ]),
      2,
    );

    expect(peaks.every((p) => p.min === 0 && p.max === 0)).toBe(true);
  });

  it("averages an asymmetric stereo pair", () => {
    const peaks = getWaveformPeaks(
      bufferOf([
        [1, 0],
        [0, 0],
      ]),
      1,
    );

    expect(peaks[0].max).toBeCloseTo(0.5);
    expect(peaks[0].min).toBeCloseTo(0);
  });

  it("drops the tail samples that do not fill a whole bucket", () => {
    // 7 samples over 2 points is 3 per bucket, so the 7th is not drawn.
    const peaks = getWaveformPeaks(bufferOf([[0, 0, 0, 0, 0, 0, 9]]), 2);

    expect(peaks).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ]);
  });

  it("gives a buffer shorter than the point count one peak per sample", () => {
    const peaks = getWaveformPeaks(bufferOf([[0.5, -0.25, 1]]), 10);

    expect(peaks).toHaveLength(3);
    expect(peaks[0]).toEqual({ min: 0.5, max: 0.5 });
    expect(peaks[1]).toEqual({ min: -0.25, max: -0.25 });
    expect(peaks[2]).toEqual({ min: 1, max: 1 });
  });

  it("still averages the channels on the short-buffer branch", () => {
    const peaks = getWaveformPeaks(
      bufferOf([
        [1, 0],
        [0, 1],
      ]),
      100,
    );

    expect(peaks).toEqual([
      { min: 0.5, max: 0.5 },
      { min: 0.5, max: 0.5 },
    ]);
  });

  it("returns nothing for an empty buffer rather than throwing", () => {
    expect(getWaveformPeaks(bufferOf([[]]), 10)).toEqual([]);
  });
});
