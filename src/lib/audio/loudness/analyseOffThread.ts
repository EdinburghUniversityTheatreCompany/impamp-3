/**
 * Runs loudness analysis in a worker, with a main-thread fallback.
 *
 * One worker, not one per file: the work is CPU-bound, so a pool would only
 * contend, and analysis is a background chore that must never compete with
 * playback. Requests queue behind each other inside the worker naturally.
 *
 * The fallback matters more than it looks. Workers can be unavailable — an
 * environment without `Worker`, a bundler that did not emit the chunk, a CSP
 * that blocks it — and analysis silently not happening means every sound plays
 * at 0 dB with no normalisation and no error. Better slow than wrong.
 *
 * @module lib/audio/loudness/analyseOffThread
 */

import { analyseLoudness } from "./analyse";
import type { LoudnessAnalysis } from "./types";
import type { AnalyseResponse } from "./analyse.worker";

let worker: Worker | null = null;
let workerUnavailable = false;
let nextRequestId = 1;

const pending = new Map<
  number,
  { resolve: (a: LoudnessAnalysis) => void; reject: (e: Error) => void }
>();

/** The shared worker instance, or null if this environment cannot have one. */
function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;

  if (typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }

  try {
    worker = new Worker(new URL("./analyse.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    workerUnavailable = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<AnalyseResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);

    if (event.data.ok) entry.resolve(event.data.analysis);
    else entry.reject(new Error(event.data.error));
  };

  worker.onerror = () => {
    // Whatever is wrong with it is wrong for every request, so stop using it
    // and let the callers fall back rather than hang.
    workerUnavailable = true;
    worker?.terminate();
    worker = null;
    for (const [, entry] of pending) {
      entry.reject(new Error("The loudness worker failed"));
    }
    pending.clear();
  };

  return worker;
}

/**
 * Measures a decoded buffer's loudness without blocking the main thread.
 *
 * @param buffer - The decoded audio
 * @returns The analysis
 */
export async function analyseAudioBufferOffThread(
  buffer: AudioBuffer,
): Promise<LoudnessAnalysis> {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    // Copied rather than passed by reference: the channel data belongs to a
    // buffer that may still be playing, and transferring it would detach it.
    channels.push(new Float32Array(buffer.getChannelData(ch)));
  }

  const instance = getWorker();
  if (!instance) return analyseLoudness(channels, buffer.sampleRate);

  const id = nextRequestId++;

  try {
    return await new Promise<LoudnessAnalysis>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      instance.postMessage(
        { id, channels, sampleRate: buffer.sampleRate },
        channels.map((c) => c.buffer),
      );
    });
  } catch {
    // The worker died or refused. The copies were transferred away, so read
    // the buffer again for the fallback.
    pending.delete(id);
    const retry: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      retry.push(new Float32Array(buffer.getChannelData(ch)));
    }
    return analyseLoudness(retry, buffer.sampleRate);
  }
}

/** Test seam: forget the worker so the next call makes a new one. */
export function resetLoudnessWorker(): void {
  worker?.terminate();
  worker = null;
  workerUnavailable = false;
  pending.clear();
}
