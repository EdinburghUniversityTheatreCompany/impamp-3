/**
 * `fetch` that gives up.
 *
 * Nothing in this app used to. A repo-wide search for `AbortController` or
 * `AbortSignal` returned exactly zero matches outside the *inbound*
 * `request.signal` on the SSE route, across 49 outbound calls to Drive, to
 * Wasabi, to Google's OAuth endpoints and to this app's own backend.
 *
 * A request with no timeout does not fail — it waits. On a captive portal, a
 * flaky mobile network or a bad minute at a storage provider, the socket simply
 * never settles, and two places then turn that single hang into permanent
 * breakage for the whole session:
 *
 * - `serverSync/sync.ts` keeps an in-flight promise per profile and clears it
 *   in a `finally`. A promise that never settles never reaches the `finally`,
 *   so every later sync for that profile returns the same dead promise.
 * - `serverAudio/transfer.ts` caches the audio-capability *promise* with `??=`.
 *   If that call hangs, every subsequent upload awaits it forever.
 *
 * Server-side the shape is worse, because this app runs as a single instance:
 * an un-timed proxy or token-exchange fetch holds a Node request handler open,
 * so a slow Google can exhaust the process.
 *
 * @module lib/fetchWithTimeout
 */

/**
 * How long to wait, by kind of request.
 *
 * Two tiers rather than one number, because the right answer differs by an
 * order of magnitude and a single compromise value would be wrong for both: a
 * 60s control-plane call is a hang nobody notices, and a 10s blob transfer is a
 * working upload cancelled on a slow connection.
 */
export const FETCH_TIMEOUTS = {
  /** JSON control-plane calls: our API, OAuth, Drive metadata, presign. */
  control: 10_000,
  /** Moving bytes: audio uploads and downloads. */
  transfer: 120_000,
} as const;

export type FetchTimeoutKind = keyof typeof FETCH_TIMEOUTS;

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Which tier of timeout applies. Defaults to `control`. */
  timeoutKind?: FetchTimeoutKind;
  /** An explicit timeout in ms, overriding `timeoutKind`. */
  timeoutMs?: number;
}

/** Thrown when the timeout fires, so callers can tell it from an HTTP error. */
export class FetchTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

/**
 * Performs a fetch that aborts if it has not settled in time.
 *
 * A caller's own `signal` still works: whichever fires first wins, so an
 * in-flight request can be cancelled early *and* cannot hang forever.
 *
 * @param input - As `fetch`
 * @param options - As `fetch`, plus `timeoutKind` or `timeoutMs`
 * @returns The response
 * @throws {FetchTimeoutError} when the timeout fires first
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutKind = "control", timeoutMs, signal, ...init } = options;
  const limit = timeoutMs ?? FETCH_TIMEOUTS[timeoutKind];

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);

  // The caller's signal has to keep working; an early cancel is not a timeout.
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new FetchTimeoutError(String(input), limit);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
