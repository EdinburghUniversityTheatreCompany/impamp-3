/**
 * The two pieces every test of an HTTP client in this repo needs: a `Response`
 * stand-in, and a way to read back the single call a wrapper made.
 *
 * `serverSync/api.ts` and `serverAudio/api.ts` are the same module twice over
 * — same-origin `fetchWithTimeout`, a share token in a header, a status fanned
 * out into typed errors — so their suites wrote the same two helpers each and
 * failed the jscpd gate, which is exactly the signal that gate exists to give.
 *
 * What cannot live here is the `vi.mock` itself: `vi.mock` is hoisted into the
 * file it is written in and cannot be called on another file's behalf (the
 * same reason `audioStackMocks.ts` uses `vi.doMock`). So each suite writes its
 * own one-line factory over the spy {@link fetchHarness} hands it.
 */

import { expect, vi, type Mock } from "vitest";

/**
 * A `Response` stand-in.
 *
 * Only `ok`, `status` and `json()` are ever read by either client, so those
 * are the whole of what this provides — a real `Response` would additionally
 * demand a body that parses, which is the opposite of what `jsonThrows` is
 * for.
 *
 * @param status - The HTTP status; `ok` is derived from it
 * @param body - What `json()` resolves to
 * @param options - `jsonThrows` makes `json()` reject, as a proxy's HTML error
 *   page would
 * @returns Something structurally sufficient for the client under test
 */
export function respondWith(
  status: number,
  body: unknown = {},
  { jsonThrows = false }: { jsonThrows?: boolean } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  } as unknown as Response;
}

/** What a client put on the wire, with the headers already normalised. */
export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

/**
 * Reads back the one call the client made, asserting that it made exactly one.
 *
 * The count assertion is not incidental: a wrapper that retried, or that fell
 * through a refusal into a second request, would otherwise be read as
 * successful by whichever call happened to be first.
 *
 * @param fetchSpy - The suite's own mock of `fetchWithTimeout`
 * @returns The URL, the init as passed, and its headers as a `Headers`
 */
export function onlyCall(fetchSpy: Mock): RecordedCall {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init = {}] = fetchSpy.mock.calls[0] as [
    string,
    RequestInit | undefined,
  ];
  return { url: String(url), init, headers: new Headers(init.headers) };
}

/**
 * The spy a suite points `vi.mock("@/lib/fetchWithTimeout")` at, together with
 * a {@link onlyCall} already bound to it.
 *
 * The suite still writes the `vi.mock` line itself — see the module comment —
 * but everything either side of it is here rather than copied.
 *
 * @returns The spy, and a no-argument reader for the call it recorded
 */
export function fetchHarness(): {
  fetchWithTimeout: Mock;
  onlyCall: () => RecordedCall;
} {
  const fetchWithTimeout = vi.fn();
  return { fetchWithTimeout, onlyCall: () => onlyCall(fetchWithTimeout) };
}
