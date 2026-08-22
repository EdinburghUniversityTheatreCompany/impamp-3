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
 * ## The deadline covers the body, not just the headers
 *
 * `fetch` resolves as soon as response *headers* arrive; the body is still
 * unread at that point. So a deadline that is cleared when `fetch` resolves
 * protects only the handshake, and a peer that sends headers and then stops
 * sending bytes hangs the caller exactly as completely as one that never
 * answered at all — which is the failure this module exists to prevent, left
 * open on the largest transfers in the app (the Drive audio proxy streams up
 * to 100 MB with the timer already disarmed).
 *
 * So the deadline stays armed across the body too. It is an **idle** deadline
 * there rather than a total one: it resets on every chunk, so a slow but
 * progressing transfer is never cancelled for being slow — only for stopping.
 * A total deadline would have to be either too short for a 100 MB download on
 * a thin venue connection or too long to catch a stall promptly; "no progress
 * for N" is the condition actually worth acting on, and it needs no second
 * number.
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
 *
 * Each is applied twice over: once to the headers, and then as an idle limit
 * between body chunks. A `transfer` download may therefore run far longer than
 * 120s in total, so long as it never goes 120s without producing a byte.
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
 * Performs a fetch that aborts if it stops making progress.
 *
 * The deadline covers the headers and then, as an idle limit reset by every
 * chunk, the body — see the module docstring for why the body half is not
 * optional.
 *
 * A caller's own `signal` still works: whichever fires first wins, so an
 * in-flight request can be cancelled early *and* cannot hang forever.
 *
 * @param input - As `fetch`
 * @param options - As `fetch`, plus `timeoutKind` or `timeoutMs`
 * @returns The response, whose body carries the remaining deadline
 * @throws {FetchTimeoutError} when the timeout fires first
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutKind = "control", timeoutMs, signal, ...init } = options;
  const limit = timeoutMs ?? FETCH_TIMEOUTS[timeoutKind];
  const url = String(input);

  const controller = new AbortController();
  let timedOut = false;

  // The caller's signal has to keep working, for the whole of the request and
  // not just its headers; an early cancel is not a timeout.
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller);
  const detachCallerSignal = () =>
    signal?.removeEventListener("abort", abortFromCaller);

  const expire = () => {
    timedOut = true;
    // Closing the socket as well as failing the read, so a stalled peer does
    // not keep a connection — and, server-side, a Node request handler — open
    // behind a caller that has already given up.
    controller.abort();
  };

  const headerTimer = setTimeout(expire, limit);

  let response: Response;
  try {
    response = await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(headerTimer);
    detachCallerSignal();
    if (timedOut) throw new FetchTimeoutError(url, limit);
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }

  // Nothing to wait for — a 204, a 304, a HEAD. Waiting on a body that will
  // never be read would leave the deadline armed until it fired.
  if (!response.body) {
    detachCallerSignal();
    return response;
  }

  const reader = response.body.getReader();
  const finish = () => {
    detachCallerSignal();
  };

  const monitored = new ReadableStream<Uint8Array>({
    async pull(out) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      try {
        const stalled = new Promise<never>((_, reject) => {
          idle = setTimeout(() => {
            expire();
            reject(new FetchTimeoutError(url, limit));
          }, limit);
        });

        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) {
          finish();
          out.close();
          return;
        }
        out.enqueue(value);
      } catch (error) {
        finish();
        // An abort reaching a body read is either ours or the caller's, and
        // only ours is a timeout. Anything else is an ordinary network failure
        // and passes through unchanged.
        out.error(
          timedOut &&
            (isAbortError(error) || error instanceof FetchTimeoutError)
            ? new FetchTimeoutError(url, limit)
            : error,
        );
        await reader.cancel().catch(() => {});
      } finally {
        clearTimeout(idle);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });

  // Rebuilt rather than mutated: `body` is read-only on a Response. Nothing in
  // this app reads `url`, `redirected` or `type` off a fetch result, which are
  // the only properties a reconstruction cannot carry over.
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
