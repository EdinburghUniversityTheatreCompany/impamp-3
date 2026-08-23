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
 * Which is exactly why every round trip has to end. A silent fallback is only
 * safe if it is always reachable: an unanswered `postMessage` leaves the
 * caller awaiting, and `analyseAndStore`'s caller is a backfill sweep that
 * never reschedules and never clears `backfillInFlight`, so one wedged file
 * takes every later analysis — including the re-analyse button — with it.
 *
 * @module lib/audio/loudness/analyseOffThread
 */

import { analyseLoudness } from "./analyse";
import { exposeE2EHook } from "@/lib/testHooks";
import type { LoudnessAnalysis } from "./types";
import type { AnalyseResponse } from "./analyse.worker";

/**
 * How long to wait for an answer, in two parts.
 *
 * One number cannot be right for both ends of the range this app is given: a
 * 30-second sting and a two-hour recording of a show differ by more than two
 * orders of magnitude in how much arithmetic they are, so a deadline generous
 * enough for the second is no deadline at all for the first, and one tight
 * enough for the first cancels the second while it is working perfectly.
 *
 * The per-second allowance is roughly sixty times the measured cost (~8 ms of
 * analysis per second of stereo audio), which leaves room for a slow machine
 * and a busy tab without ever being mistaken for a working request.
 */
const LOUDNESS_WORKER_TIMEOUTS = {
  /** Floor for any request, however short the audio. */
  base: 30_000,
  /** Extra allowance per second of audio still queued. */
  perAudioSecond: 500,
} as const;

/**
 * How many times in a row a worker may fail before this stops making them.
 *
 * Not one. "This environment has no workers" and "this one message failed"
 * deserve different answers, and the old code gave them the same one: a single
 * `onerror` disabled the worker for the session, so one transient failure
 * silently restored the main-thread freeze the worker exists to remove. But a
 * worker that cannot load will not load on the fourth attempt either, and
 * paying a construction and a rejection per file forever is worse than the
 * fallback the caller already has.
 */
export const MAX_CONSECUTIVE_WORKER_FAILURES = 3;

/**
 * The deadline for a request, given how much audio is outstanding.
 *
 * The worker is serial, so a request's clock starts when it is posted and not
 * when the worker reaches it. Sizing the deadline by this file alone would
 * cancel healthy work during a bulk import, where nine files can legitimately
 * sit ahead of the tenth.
 *
 * @param queuedAudioSeconds - Total audio, in seconds, this request waits on
 * @returns The deadline in milliseconds
 */
export function loudnessWorkerTimeoutMs(queuedAudioSeconds: number): number {
  const queued =
    Number.isFinite(queuedAudioSeconds) && queuedAudioSeconds > 0
      ? queuedAudioSeconds
      : 0;
  return (
    LOUDNESS_WORKER_TIMEOUTS.base +
    queued * LOUDNESS_WORKER_TIMEOUTS.perAudioSecond
  );
}

/** Thrown when a round trip runs out of time, so it reads as itself in a log. */
class LoudnessWorkerTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The loudness worker did not answer within ${timeoutMs}ms`);
    this.name = "LoudnessWorkerTimeoutError";
  }
}

let worker: Worker | null = null;
/** Set only when this environment can never have a worker at all. */
let workerUnavailable = false;
let consecutiveWorkerFailures = 0;
let nextRequestId = 1;

/**
 * How analyses have actually been served, for the e2e suite.
 *
 * The fallback is deliberately silent — better slow than wrong — which also
 * means a worker that never loads is indistinguishable from one that works,
 * from outside. It once did exactly that in every production build. Counting
 * is the only way a test can tell the two apart.
 */
const served = { byWorker: 0, onMainThread: 0 };

interface PendingAnalysis {
  resolve: (analysis: LoudnessAnalysis) => void;
  reject: (error: Error) => void;
  /** The deadline's handle, cleared however the request settles. */
  timer: ReturnType<typeof setTimeout>;
  /** Seconds of audio, so later requests can be given room for this one. */
  durationSeconds: number;
}

const pending = new Map<number, PendingAnalysis>();

/** Removes a pending entry and cancels its deadline, returning it if present. */
function takePending(id: number): PendingAnalysis | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  return entry;
}

/** Fails everything still waiting, so no caller is left holding a dead promise. */
function rejectAllPending(message: string): void {
  for (const id of [...pending.keys()]) {
    takePending(id)?.reject(new Error(message));
  }
}

/**
 * Throws away the current worker and counts it against the retry budget.
 *
 * Recycling rather than latching is the point: whatever is wrong with an
 * instance — it was killed under memory pressure, a reply failed to
 * deserialise, one message went unanswered — is wrong with *that* instance,
 * and the next request deserves a fresh one. Only a run of failures is
 * evidence about the environment.
 *
 * @param reason - What went wrong, for the log and for the rejections
 */
function discardWorker(reason: string): void {
  consecutiveWorkerFailures++;
  worker?.terminate();
  worker = null;

  if (consecutiveWorkerFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
    workerUnavailable = true;
    console.warn(
      `[Loudness] Giving up on the analysis worker after ${consecutiveWorkerFailures} failures (${reason}). Measuring on the main thread from here.`,
    );
  } else {
    console.warn(`[Loudness] Recycling the analysis worker: ${reason}`);
  }

  rejectAllPending(reason);
}

/** The shared worker instance, or null if this environment cannot have one. */
function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;

  if (typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }

  try {
    // A production build also emits this file's TypeScript verbatim to
    // /_next/static/media/analyse.worker.<hash>.ts. That asset is a decoy: the
    // constructor below is compiled to a turbopack-worker bootstrap that loads
    // the real chunks, which `loudness-worker.spec.ts` asserts against the
    // built app. Reading the build output alone suggests this is broken and it
    // is not — check the spec before "fixing" the specifier.
    worker = new Worker(new URL("./analyse.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    // A constructor that throws is the environment answering, not one bad
    // message, so this is the one failure that latches immediately.
    workerUnavailable = true;
    return null;
  }

  worker.onmessage = (event: MessageEvent<AnalyseResponse>) => {
    const entry = takePending(event.data.id);
    if (!entry) return;

    if (event.data.ok) {
      // A worker that answers is a working worker; whatever went wrong before
      // did not carry over, so it must not count towards abandoning this one.
      consecutiveWorkerFailures = 0;
      entry.resolve(event.data.analysis);
    } else {
      entry.reject(new Error(event.data.error));
    }
  };

  worker.onerror = () => {
    discardWorker("the worker reported an error");
  };

  // The other way a round trip ends without an `onmessage`: the reply arrived
  // but could not be structured-cloned back into this thread. Without this the
  // request simply stays in `pending` until its deadline.
  worker.onmessageerror = () => {
    discardWorker("a reply from the worker could not be deserialised");
  };

  return worker;
}

/** Seconds of audio already posted and not yet answered. */
function queuedAudioSeconds(): number {
  let total = 0;
  for (const entry of pending.values()) total += entry.durationSeconds;
  return total;
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
  if (!instance) {
    served.onMainThread++;
    return analyseLoudness(channels, buffer.sampleRate);
  }

  const id = nextRequestId++;
  const durationSeconds = buffer.duration;
  const timeoutMs = loudnessWorkerTimeoutMs(
    queuedAudioSeconds() + durationSeconds,
  );

  try {
    const analysis = await new Promise<LoudnessAnalysis>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unanswered request means an unresponsive worker, not a slow one:
        // it is serial, so every request behind this one would wait out its
        // own deadline before falling back. Discarding rejects them all now.
        pending.get(id)?.reject(new LoudnessWorkerTimeoutError(timeoutMs));
        pending.delete(id);
        discardWorker(`no answer within ${timeoutMs}ms`);
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer, durationSeconds });
      instance.postMessage(
        { id, channels, sampleRate: buffer.sampleRate },
        channels.map((c) => c.buffer),
      );
    });
    served.byWorker++;
    return analysis;
  } catch {
    served.onMainThread++;
    // The worker died or refused. The copies were transferred away, so read
    // the buffer again for the fallback.
    takePending(id);
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
  consecutiveWorkerFailures = 0;
  // Rejected, not dropped: clearing the map on its own strands whatever was
  // awaiting an entry, which is the very hang this module now bounds.
  rejectAllPending("the loudness worker was reset");
  served.byWorker = 0;
  served.onMainThread = 0;
}

exposeE2EHook("__impampLoudnessAnalysis", () => ({ ...served }));
