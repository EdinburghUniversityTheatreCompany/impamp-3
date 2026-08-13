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

/** App Router hands route handlers their params as a promise. */
export const routeParams = <T extends object>(params: T) => ({
  params: Promise.resolve(params),
});
