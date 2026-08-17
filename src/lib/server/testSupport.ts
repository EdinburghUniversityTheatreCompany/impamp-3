/**
 * Helpers shared by the API route tests.
 *
 * Test-only, but it lives in `src/` so the route tests can import it through
 * the `@/` alias like anything else. Nothing in the app imports it, so it is
 * never bundled.
 */

import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "./session";

export interface ApiRequestOptions {
  method?: string;
  sessionToken?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: string;
}

/** A NextRequest shaped like the ones the route handlers really receive. */
export function makeApiRequest(
  path: string,
  options: ApiRequestOptions = {},
): NextRequest {
  const headers = new Headers(options.headers);
  if (options.sessionToken) {
    headers.set("cookie", `${SESSION_COOKIE}=${options.sessionToken}`);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(
    `http://localhost${path}${options.query ? `?${options.query}` : ""}`,
    {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
}

export interface ChunkedRequestOptions extends ApiRequestOptions {
  /** How much body to offer, in bytes. */
  totalBytes: number;
  /** How much of it to hand over per `pull`. */
  chunkBytes?: number;
}

/**
 * A request whose body arrives in chunks and carries no `content-length` —
 * what a chunked upload looks like on the wire, and the shape that walks past
 * a declared-length guard. `delivered()` reports how much of it the handler
 * actually pulled, which is the property worth asserting on: a handler that
 * refuses only after reading everything has not refused anything.
 */
export function makeChunkedApiRequest(
  path: string,
  { totalBytes, chunkBytes = 64 * 1024, ...options }: ChunkedRequestOptions,
): { request: NextRequest; delivered: () => number } {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.sessionToken) {
    headers.set("cookie", `${SESSION_COOKIE}=${options.sessionToken}`);
  }

  let delivered = 0;
  const filler = new TextEncoder().encode(" ".repeat(chunkBytes));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - delivered);
      delivered += size;
      controller.enqueue(filler.slice(0, size));
    },
  });

  const request = new NextRequest(
    `http://localhost${path}${options.query ? `?${options.query}` : ""}`,
    {
      method: options.method ?? "PUT",
      headers,
      body,
      // Node requires this for a streaming request body. Not in the DOM lib's
      // RequestInit, hence the cast.
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1],
  );

  return { request, delivered: () => delivered };
}

/** App Router hands route handlers their params as a promise. */
export const routeParams = <T extends object>(params: T) => ({
  params: Promise.resolve(params),
});
