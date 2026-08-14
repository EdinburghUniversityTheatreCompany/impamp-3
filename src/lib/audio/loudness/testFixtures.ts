/**
 * Audio Module - Loudness test fixtures
 *
 * Shared signal generators for the loudness test suite. Pure functions over
 * Float32Array, so they run in Vitest's node environment same as the code
 * under test.
 *
 * @module lib/audio/loudness/testFixtures
 */

export const TEST_SAMPLE_RATE = 48000;

/** A sine wave at a given frequency, duration and level (dBFS, peak amplitude). */
export function sine(
  freq: number,
  seconds: number,
  dbfs: number,
  sampleRate: number = TEST_SAMPLE_RATE,
): Float32Array {
  const amplitude = 10 ** (dbfs / 20);
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

/** Concatenates Float32Arrays end to end. */
export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
