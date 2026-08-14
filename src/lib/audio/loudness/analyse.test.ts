import { describe, expect, it } from "vitest";
import { LOUDNESS_ALGO_VERSION, LOUDNESS_OFFSET_DB } from "./constants";
import { analyseLoudness } from "./analyse";

const SAMPLE_RATE = 48000;

function sine(freq: number, seconds: number, dbfs: number): Float32Array {
  const amplitude = 10 ** (dbfs / 20);
  const n = Math.floor(SAMPLE_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

/** Ungated mean of block loudness — enough to check the constant-signal case. */
function meanBlockLufs(blockMeanSquare: Float32Array): number {
  let sum = 0;
  for (const w of blockMeanSquare) sum += w;
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(sum / blockMeanSquare.length);
}

describe("analyseLoudness", () => {
  it("produces one block per 100 ms hop, less the block length", () => {
    const result = analyseLoudness([sine(1000, 2, -23)], SAMPLE_RATE);
    // 2s of audio, 400 ms blocks at a 100 ms hop => 17 complete blocks.
    expect(result.blockMeanSquare.length).toBe(17);
    expect(result.hopTruePeak.length).toBe(20);
  });

  // EBU Tech 3341 case 1. A stereo 1 kHz sine at -23 dBFS in both channels
  // must read -23.0 LUFS. This single number pins the filter, the -0.691
  // offset and the channel summing all at once.
  it("measures a stereo -23 dBFS 1 kHz sine as -23 LUFS", () => {
    const left = sine(1000, 5, -23);
    const right = sine(1000, 5, -23);
    const result = analyseLoudness([left, right], SAMPLE_RATE);
    expect(meanBlockLufs(result.blockMeanSquare)).toBeCloseTo(-23.0, 1);
  });

  // Channels are summed, not averaged. The same signal in one channel only
  // must therefore read 3.01 dB lower, not the same.
  it("sums channels rather than averaging them", () => {
    const mono = analyseLoudness([sine(1000, 5, -23)], SAMPLE_RATE);
    expect(meanBlockLufs(mono.blockMeanSquare)).toBeCloseTo(-26.01, 1);
  });

  it("measures the same LUFS at 44.1 kHz as at 48 kHz", () => {
    const n = Math.floor(44100 * 5);
    const amplitude = 10 ** (-23 / 20);
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ch[i] = amplitude * Math.sin((2 * Math.PI * 1000 * i) / 44100);
    }
    const result = analyseLoudness([ch, ch], 44100);
    expect(meanBlockLufs(result.blockMeanSquare)).toBeCloseTo(-23.0, 1);
  });

  it("records metadata", () => {
    const result = analyseLoudness([sine(1000, 1, -23)], SAMPLE_RATE);
    expect(result.algoVersion).toBe(LOUDNESS_ALGO_VERSION);
    expect(result.sampleRate).toBe(SAMPLE_RATE);
    expect(result.duration).toBeCloseTo(1, 2);
  });

  it("returns no blocks for audio shorter than one block", () => {
    const result = analyseLoudness([sine(1000, 0.2, -23)], SAMPLE_RATE);
    expect(result.blockMeanSquare.length).toBe(0);
    expect(result.hopTruePeak.length).toBe(2);
  });

  it("handles an empty channel list without throwing", () => {
    const result = analyseLoudness([], SAMPLE_RATE);
    expect(result.blockMeanSquare.length).toBe(0);
    expect(result.duration).toBe(0);
  });
});
