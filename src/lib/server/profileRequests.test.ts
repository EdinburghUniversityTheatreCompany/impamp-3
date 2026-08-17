/**
 * How a profile write body is read.
 *
 * The interesting property is not what `parseProfileBody` returns but how much
 * it consumes getting there. This app is deployed as a single instance with a
 * synchronous SQLite layer, so a body it buffers before refusing is the whole
 * service's memory — and `PUT /api/profiles/:id` is reachable with nothing but
 * an editor share link, a string that gets pasted into group chats.
 */

import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { parseProfileBody } from "./profileRequests";
import { makeChunkedApiRequest } from "./testSupport";

const MB = 1024 * 1024;

describe("parseProfileBody", () => {
  it("stops reading an oversized chunked body instead of buffering it whole", async () => {
    // 64 MiB with no content-length. `Number(null ?? "")` is 0 — finite, and
    // comfortably under the cap — so the declared-length guard passed and
    // `await request.json()` then buffered and parsed the lot. Next 16 App
    // Router handlers have no body-size limit of their own.
    const { request, delivered } = makeChunkedApiRequest("/api/profiles/x", {
      totalBytes: 64 * MB,
    });

    const result = await parseProfileBody(request);

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(413);
    // Refused near the cap, not after reading everything. One chunk of
    // overshoot is expected: the ceiling is crossed part-way through a read.
    expect(delivered()).toBeLessThan(9 * MB);
  });

  it("still refuses on a declared length over the cap, before reading the body", async () => {
    const { request, delivered } = makeChunkedApiRequest("/api/profiles/x", {
      totalBytes: 64 * MB,
    });
    request.headers.set("content-length", String(64 * MB));

    const result = await parseProfileBody(request);

    expect((result as NextResponse).status).toBe(413);
    // Undici pumps a chunk or two into the request as it is constructed, so
    // this is "did not read the body", not "read literally nothing".
    expect(delivered()).toBeLessThan(MB);
  });

  it("accepts an ordinary body", async () => {
    const request = new NextRequest("http://localhost/api/profiles/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Panto", data: { a: 1 } }),
    });

    const result = await parseProfileBody(request);

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({ name: "Panto", serialisedData: '{"a":1}' });
  });

  it("measures the cap in bytes rather than UTF-16 code units", async () => {
    // `serialisedData.length` counts code units, so a blob of astral-plane
    // characters could be ~2-3x the intended byte ceiling and still pass.
    const emoji = "😀".repeat(3 * MB);
    const request = new NextRequest("http://localhost/api/profiles/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Panto", data: { emoji } }),
    });

    const result = await parseProfileBody(request);

    // 3M emoji is 6M UTF-16 code units but 12 MB of UTF-8.
    expect((result as NextResponse).status).toBe(413);
  });

  it("rejects a body that is not JSON", async () => {
    const request = new NextRequest("http://localhost/api/profiles/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });

    expect((await parseProfileBody(request)) as NextResponse).toHaveProperty(
      "status",
      400,
    );
  });
});
