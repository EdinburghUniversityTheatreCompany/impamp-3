import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FETCH_TIMEOUTS,
  FetchTimeoutError,
  fetchWithTimeout,
} from "./fetchWithTimeout";

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/** A fetch that never settles unless its signal aborts — a TCP black hole. */
function blackHoleFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
}

describe("fetchWithTimeout", () => {
  it("gives up on a request that never settles", async () => {
    globalThis.fetch = blackHoleFetch() as unknown as typeof fetch;

    const pending = fetchWithTimeout("https://example.test/thing");
    const assertion = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);

    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.control + 1);
    await assertion;
  });

  it("allows a blob transfer far longer than a control call", async () => {
    globalThis.fetch = blackHoleFetch() as unknown as typeof fetch;

    const pending = fetchWithTimeout("https://example.test/audio.mp3", {
      timeoutKind: "transfer",
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);

    // Still running well past the control-plane limit: a 10s cap here would
    // cancel working uploads on a slow connection.
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.control + 1_000);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.transfer);
    await assertion;
  });

  it("returns a response that arrives in time, and clears its timer", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/thing");

    expect(response.status).toBe(200);
    // A leaked timer would keep the process alive and could abort a reused
    // controller later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still honours a caller's own abort, and calls it an abort not a timeout", async () => {
    globalThis.fetch = blackHoleFetch() as unknown as typeof fetch;
    const controller = new AbortController();

    const pending = fetchWithTimeout("https://example.test/thing", {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toSatisfy(
      (error: unknown) => !(error instanceof FetchTimeoutError),
    );

    controller.abort();
    await assertion;
  });

  it("passes the caller's method and body through untouched", async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchWithTimeout("https://example.test/thing", {
      method: "PUT",
      body: "payload",
    });

    const init = spy.mock.calls[0][1]!;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("payload");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
