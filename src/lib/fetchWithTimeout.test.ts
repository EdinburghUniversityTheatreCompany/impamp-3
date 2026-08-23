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

  it("returns a response that arrives in time, and clears its timer once the body is read", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/thing");
    expect(response.status).toBe(200);

    // The deadline deliberately outlives the headers now — see the body-phase
    // tests below — so it is reading the body that releases it.
    expect(await response.text()).toBe("ok");

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
  /**
   * A fetch whose *headers* arrive at once and whose body then behaves however
   * the test says. This is the shape the header-only timeout could not see: by
   * the time the body matters, `fetch` has already resolved.
   */
  function bodyFetch(body: ReadableStream<Uint8Array>) {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(body, { status: 200 });
    });
  }

  it("times out a body that stalls after the headers arrive", async () => {
    // Headers land immediately; the body then never produces a chunk. Before
    // the deadline covered the body, this hung forever — the exact failure
    // this module exists to prevent, on the largest transfers in the app.
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    globalThis.fetch = bodyFetch(stalled) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/audio.mp3");
    const reading = expect(response.arrayBuffer()).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.control + 1);
    await reading;
  });

  it("does not cut off a slow body that is still making progress", async () => {
    // The deadline is an *idle* one across the body: a 100 MB download on a
    // thin connection must not be cancelled for being slow, only for stopping.
    let push: (chunk: Uint8Array) => void = () => {};
    let finish: () => void = () => {};
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        finish = () => controller.close();
      },
    });
    globalThis.fetch = bodyFetch(trickle) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/audio.mp3", {
      timeoutKind: "transfer",
    });
    const reading = response.arrayBuffer();

    // Four chunks, each arriving at 80% of the idle limit — well past the
    // total elapsed time a whole-request deadline would have allowed.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.transfer * 0.8);
      push(new Uint8Array([i]));
    }
    finish();

    expect(new Uint8Array(await reading)).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a stalled body as a timeout, not an ordinary abort", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    globalThis.fetch = bodyFetch(stalled) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/audio.mp3");
    const reading = expect(response.text()).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUTS.control + 1);
    await reading;
  });

  it("releases the deadline for a response that carries no body at all", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/thing", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    // Nothing will ever read a 204, so waiting on a body would leak the timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the status, statusText and headers of the original response", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("payload", {
          status: 206,
          statusText: "Partial Content",
          headers: { "content-type": "audio/wav", "content-length": "7" },
        }),
    ) as unknown as typeof fetch;

    const response = await fetchWithTimeout("https://example.test/audio.wav");

    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("payload");
  });
});
