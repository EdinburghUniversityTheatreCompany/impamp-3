/**
 * In-process rate limiting and concurrency capping.
 *
 * There was none, anywhere. The two public Drive proxies are unauthenticated,
 * serve up to 100 MB, and spend the deployment's own `GOOGLE_API_KEY` doing
 * it; `/api/audio/upload-url` mints presigned PUTs; the SSE endpoint holds a
 * connection open per watcher and re-authorises it on a 25s heartbeat. The
 * only thing standing in front of any of them was the `Sec-Fetch-Site` check
 * in `api/drive/proxyUtils.ts`, which stops a cross-origin *browser* and does
 * nothing at all about a script — see the note there.
 *
 * In-process for the same reason `events.ts` is: the app runs as a single
 * container behind Kamal, so there is no second instance whose counts would
 * have to agree. Running more than one replica would multiply every limit
 * below by the replica count, which is a reason to reach for a shared store,
 * not a reason to have no limit now.
 *
 * @module lib/server/rateLimit
 */

import type { NextRequest } from "next/server";

/**
 * Who a request is counted against.
 *
 * `x-forwarded-for`'s **rightmost** entry, not its leftmost. The header is a
 * list the client starts and each proxy appends to, so the leftmost value is
 * whatever the caller chose to claim — one `curl -H 'X-Forwarded-For: …'` and
 * every request looks like a different client. The rightmost was written by
 * the nearest proxy, which behind kamal-proxy is the only one there is.
 *
 * Returns `null` when no proxy header is present at all. That is a deployment
 * with nothing in front of it — a dev server, or the E2E run — and callers
 * treat it as "do not limit". The alternative, bucketing every such request
 * together, would hand one caller the ability to lock out everyone else, which
 * is a worse failure than the one being prevented. In production kamal-proxy
 * always sets the header, so there is nothing to strip.
 */
export function clientKey(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return request.headers.get("x-real-ip")?.trim() || null;
}

export interface RateLimit {
  /** How many requests are allowed in one window. */
  limit: number;
  /** How long that window is, in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when refused. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * How many keys may be held before expired ones are swept.
 *
 * A fixed window leaves an entry per distinct key until it is looked at again,
 * and the keys here are attacker-chosen (an IP per request, if someone has a
 * range). Without this the map is the memory leak the limiter was added to
 * prevent. The sweep is O(n) but runs only when the map has grown past this,
 * so an ordinary deployment never pays for it.
 */
const SWEEP_ABOVE_KEYS = 10_000;

function sweepExpired(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

/**
 * Count one request against a key.
 *
 * A fixed window rather than a token bucket: the numbers below are generous
 * enough that burst smoothing buys nothing, and a window is one integer and
 * one timestamp per key rather than a rate to decay.
 *
 * @param key - The bucket, already namespaced by caller (`"drive:1.2.3.4"`)
 * @param limit - The allowance
 * @returns Whether the request may proceed, and when to try again if not
 */
export function consume(key: string, limit: RateLimit): RateLimitResult {
  const now = Date.now();

  if (windows.size > SWEEP_ABOVE_KEYS) sweepExpired(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      ),
    };
  }

  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

const inFlight = new Map<string, number>();

/**
 * Take one concurrency slot, or refuse.
 *
 * Separate from `consume` because they bound different things. A rate limit
 * bounds how often something may be *started*; this bounds how many may be
 * running at once, which for a long-lived connection — an SSE stream — is the
 * cost that matters, since a stream started an hour ago is still charging its
 * heartbeat's four SQLite queries every 25 seconds.
 *
 * @param key - The bucket
 * @param max - How many may be in flight at once
 * @returns A release function, or `null` if the caller is at its limit.
 *   Releasing twice is safe; the second call does nothing.
 */
export function acquire(key: string, max: number): (() => void) | null {
  const current = inFlight.get(key) ?? 0;
  if (current >= max) return null;

  inFlight.set(key, current + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = inFlight.get(key) ?? 0;
    // Deleting at zero rather than leaving a 0 behind, so a key that is no
    // longer in use stops occupying the map — the same reason
    // `subscribeToProfile` drops its empty Set.
    if (now <= 1) inFlight.delete(key);
    else inFlight.set(key, now - 1);
  };
}

/** In-flight count for a key. For tests and diagnostics. */
export function inFlightCount(key: string): number {
  return inFlight.get(key) ?? 0;
}

/** Drop all state. Tests only — each one wants a clean slate. */
export function resetRateLimitState(): void {
  windows.clear();
  inFlight.clear();
}

/**
 * The limits themselves, in one place so they can be read against each other.
 *
 * All are set well above what the application itself generates, because the
 * failure they must never produce is refusing a real operator mid-show. They
 * are a bound on abuse, not a quota.
 */
export const LIMITS = {
  /**
   * The public Drive proxies, per client.
   *
   * `public-audio` is called **once per sound** when someone opens a shared
   * board, so this cannot be a small number: a 300-sound board would trip
   * anything tighter on first load. 2/second sustained clears that, and the
   * responses carry `Cache-Control: max-age=3600`, so opening the same board
   * again costs nothing.
   */
  driveProxy: { limit: 600, windowMs: 5 * 60_000 } satisfies RateLimit,

  /**
   * Presigned upload URLs, per account.
   *
   * Uploads are deliberate user actions and this is already behind
   * authentication and a quota; the limit is here so that a stolen session
   * cannot mint URLs in a loop.
   */
  uploadUrl: { limit: 120, windowMs: 60 * 60_000 } satisfies RateLimit,

  /**
   * Concurrent SSE streams per client.
   *
   * One per profile a browser is watching, times a few tabs. Eight is more
   * than a real operator opens and far fewer than the thousands one script
   * could, each of which costs four synchronous SQLite queries per 25s
   * heartbeat on the thread that serves every other request.
   */
  sseStreams: 8,
} as const;
