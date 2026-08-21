/**
 * Reading a request body without letting the caller decide how much memory it
 * costs.
 *
 * There is one reader here and two limits, rather than two ways to read a body.
 * That distinction is the whole point of this module: SV2 gave the profile
 * write path a streaming ceiling because that is where a large body is
 * *expected*, and left `await request.json()` in place everywhere else — where
 * a large body is merely unexpected, which is not the same as impossible. The
 * five routes that kept it are as unbounded as the profile route was, and one
 * of them (`POST /api/auth/google/exchange`) needs no session to reach.
 *
 * `content-length` cannot be the guard. A chunked request carries no such
 * header, and `Number(null ?? "")` is 0 — finite, and comfortably under any
 * cap — so a header test passes and the body gets buffered anyway. It is kept
 * below only as a cheap early refusal for honest clients.
 *
 * This app is deployed as a single instance with a synchronous SQLite layer, so
 * a body it buffers before refusing is the whole service's memory.
 *
 * @module lib/server/requestBody
 */

import { NextRequest, NextResponse } from "next/server";

/**
 * The ceiling for a body that is not a profile blob.
 *
 * These carry an OAuth code, an email address, a role, a boolean, a quota
 * number — hundreds of bytes in practice. 64 KiB is far more than any of them
 * needs and far less than a request should be able to cost.
 */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export function tooLargeResponse(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 413 });
}

/**
 * The request body as text, refusing once it exceeds `maxBytes`.
 *
 * @param request - The incoming request
 * @param maxBytes - The ceiling, counted in bytes actually received
 * @param tooLargeMessage - What the 413 should say
 * @returns The body text, or the response to send instead
 */
export async function readBodyText(
  request: NextRequest,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string | NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return tooLargeResponse(tooLargeMessage);
  }

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        // Abort rather than drain: nothing further is going to be used, and
        // reading it to the end is the cost this exists to avoid.
        await reader.cancel().catch(() => {});
        return tooLargeResponse(tooLargeMessage);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  return text;
}

/**
 * A small JSON object body, or the response to send instead.
 *
 * Narrowed to an object deliberately. `JSON.parse` yields null, a number or an
 * array just as happily, and every caller of this goes straight on to read
 * properties off what it returns — so the alternative to a 400 here is a
 * TypeError and a 500 somewhere further in.
 *
 * @param request - The incoming request
 * @param maxBytes - Override the default ceiling, for a body that needs it
 * @returns The parsed object, or a 400/413
 */
export async function parseJsonBody<T extends object>(
  request: NextRequest,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T | NextResponse> {
  const text = await readBodyText(
    request,
    maxBytes,
    "That request body is too large",
  );
  if (text instanceof NextResponse) return text;

  const invalid = NextResponse.json(
    { error: "Invalid JSON body" },
    { status: 400 },
  );

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return invalid;
    return parsed as T;
  } catch {
    return invalid;
  }
}
