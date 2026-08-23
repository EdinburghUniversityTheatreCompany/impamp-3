import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  acquire,
  clientKey,
  consume,
  inFlightCount,
  LIMITS,
  resetRateLimitState,
} from "./rateLimit";

beforeEach(() => {
  resetRateLimitState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetRateLimitState();
});

function requestWith(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://impamp.test/api/drive/public-file?id=abc", {
    headers,
  });
}

describe("clientKey", () => {
  it("takes the rightmost x-forwarded-for entry, not the leftmost", () => {
    // The leftmost is whatever the caller claimed; the rightmost is what the
    // nearest proxy wrote. Keying on the leftmost would let one script look
    // like an unlimited number of distinct clients.
    expect(
      clientKey(requestWith({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  it("is not fooled by a caller inventing hops", () => {
    const spoofed = requestWith({
      "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7",
    });
    expect(clientKey(spoofed)).toBe("203.0.113.7");
  });

  it("handles a single-entry header and stray whitespace", () => {
    expect(
      clientKey(requestWith({ "x-forwarded-for": "  203.0.113.7 " })),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientKey(requestWith({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  it("is null when nothing is in front of the app", () => {
    // A dev server or the E2E run. Callers read this as "do not limit" —
    // bucketing every such request together would let one caller lock out
    // everyone else, which is worse than the problem.
    expect(clientKey(requestWith({}))).toBeNull();
  });
});

describe("consume", () => {
  const limit = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit and refuses past it", () => {
    for (let i = 0; i < 3; i++) {
      expect(consume("k", limit).allowed).toBe(true);
    }
    expect(consume("k", limit).allowed).toBe(false);
  });

  it("reports how long to wait, in whole seconds and never zero", () => {
    for (let i = 0; i < 3; i++) consume("k", limit);
    vi.advanceTimersByTime(59_500);

    const refused = consume("k", limit);
    expect(refused.allowed).toBe(false);
    // 500ms remain; a `Retry-After: 0` would invite an immediate retry.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it("starts a fresh window once the old one has passed", () => {
    for (let i = 0; i < 3; i++) consume("k", limit);
    expect(consume("k", limit).allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(consume("k", limit).allowed).toBe(true);
  });

  it("keeps one key's budget away from another's", () => {
    for (let i = 0; i < 3; i++) consume("a", limit);
    expect(consume("a", limit).allowed).toBe(false);
    expect(consume("b", limit).allowed).toBe(true);
  });

  it("does not grow without bound when keys are attacker-chosen", () => {
    // An IP per request is the shape to defend against: without the sweep the
    // limiter is itself the memory leak.
    for (let i = 0; i < 10_050; i++) {
      consume(`ip-${i}`, { limit: 1, windowMs: 1_000 });
    }
    vi.advanceTimersByTime(2_000);
    // One more consume crosses the sweep threshold and clears the expired.
    consume("trigger", { limit: 1, windowMs: 1_000 });

    // Everything before the sweep had expired, so the survivor is the trigger.
    expect(consume("ip-0", { limit: 1, windowMs: 1_000 }).allowed).toBe(true);
  });
});

describe("acquire", () => {
  it("hands out up to max slots and then refuses", () => {
    const first = acquire("k", 2);
    const second = acquire("k", 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(acquire("k", 2)).toBeNull();
  });

  it("frees a slot on release", () => {
    const first = acquire("k", 1)!;
    expect(acquire("k", 1)).toBeNull();
    first();
    expect(acquire("k", 1)).not.toBeNull();
  });

  it("survives a double release without freeing two slots", () => {
    // The SSE route's cleanup can run more than once — an abort and a lifetime
    // timeout can both fire — and a slot freed twice is a slot invented.
    const held = acquire("k", 2)!;
    const other = acquire("k", 2)!;
    held();
    held();
    expect(inFlightCount("k")).toBe(1);
    other();
    expect(inFlightCount("k")).toBe(0);
  });

  it("drops a key that nobody is holding", () => {
    const release = acquire("k", 1)!;
    release();
    expect(inFlightCount("k")).toBe(0);
  });
});

describe("LIMITS", () => {
  it("lets a large shared board load every sound in one window", () => {
    // `public-audio` is called once per sound. A limit below this refuses a
    // legitimate first open of a big board, which is the failure that must
    // never happen — the point is to bound abuse, not to ration operators.
    const soundsOnABigBoard = 300;
    expect(LIMITS.driveProxy.limit).toBeGreaterThan(soundsOnABigBoard);
  });

  it("allows more concurrent streams than a real operator opens", () => {
    expect(LIMITS.sseStreams).toBeGreaterThanOrEqual(4);
  });
});
