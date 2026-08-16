/**
 * Loudness analysis, off the main thread.
 *
 * The measurement is ~2.2 seconds of straight-line arithmetic per minute of
 * stereo audio — dominated by the true-peak interpolator, which does 36
 * multiply-accumulates per sample per channel — and it used to run on the main
 * thread, unqueued, once per file added. Dropping forty files onto pads froze
 * the tab for minutes: no paint, no input, and the Web Audio render quantum
 * under-running so a sound already playing glitched.
 *
 * `analyseLoudness` was already pure and Web-Audio-free, which is what makes
 * this possible: its inputs are plain `Float32Array`s, so they transfer with
 * no copy.
 *
 * @module lib/audio/loudness/analyse.worker
 */

import { analyseLoudness } from "./analyse";
import type { LoudnessAnalysis } from "./types";

export interface AnalyseRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
}

export type AnalyseResponse =
  | { id: number; ok: true; analysis: LoudnessAnalysis }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<AnalyseRequest>) => {
  const { id, channels, sampleRate } = event.data;

  try {
    const analysis = analyseLoudness(channels, sampleRate);
    const response: AnalyseResponse = { id, ok: true, analysis };
    // The two Float32Arrays are the only large things going back, and the
    // worker has no further use for them.
    (self as unknown as Worker).postMessage(response, [
      analysis.blockMeanSquare.buffer,
      analysis.hopTruePeak.buffer,
    ]);
  } catch (error) {
    const response: AnalyseResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
