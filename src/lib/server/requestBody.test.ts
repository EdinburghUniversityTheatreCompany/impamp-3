/**
 * How every *other* route reads its body.
 *
 * SV2 gave `parseProfileBody` a streaming ceiling, because that is the one
 * endpoint where a large body is expected. Every other route kept
 * `await request.json()`, which buffers and parses whatever arrives with no
 * ceiling of its own — the identical hole, in five places, differing only in
 * that nobody expected a big body there.
 *
 * Two of those are worth naming. `POST /api/auth/google/exchange` needs no
 * session at all, so anyone on the internet can hand this single-instance,
 * synchronously-SQLite process as much memory as it will take. And
 * `POST /api/profiles/:id/shares` is reachable by any owner. Neither can be
 * fixed by a `content-length` check: a chunked request carries no such header,
 * which is exactly why SV2's guard needed a counting reader rather than a
 * header test.
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "./db";
import { createSession } from "./session";
import { upsertUserFromGoogle } from "./users";
import { createProfile } from "./profiles";
import { parseJsonBody, MAX_JSON_BODY_BYTES } from "./requestBody";
import { makeChunkedApiRequest, routeParams } from "./testSupport";

import { POST as postExchange } from "@/app/api/auth/google/exchange/route";
import { POST as postShare } from "@/app/api/profiles/[id]/shares/route";

const MB = 1024 * 1024;

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

/** A chunked body with no content-length, offered in small pieces. */
const flood = (path: string, options: { sessionToken?: string } = {}) =>
  makeChunkedApiRequest(path, {
    method: "POST",
    totalBytes: 64 * MB,
    chunkBytes: 8 * 1024,
    ...options,
  });

describe("parseJsonBody", () => {
  it("stops reading a body that will not fit instead of buffering it", async () => {
    const { request, delivered } = flood("/api/anything");

    const result = await parseJsonBody(request);

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(413);
    expect(delivered()).toBeLessThan(MAX_JSON_BODY_BYTES + 64 * 1024);
  });

  it("refuses JSON that is not an object rather than handing back a null", async () => {
    // `await request.json()` yields null, a number or an array just as happily
    // as an object, and every caller here goes straight on to read properties
    // off what it gets back.
    const request = new NextRequest("http://localhost/api/anything", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });

    const result = await parseJsonBody(request);

    expect((result as NextResponse).status).toBe(400);
  });

  it("accepts an ordinary body", async () => {
    const request = new NextRequest("http://localhost/api/anything", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });

    expect(await parseJsonBody<{ code: string }>(request)).toEqual({
      code: "abc",
    });
  });
});

describe("routes that read a small JSON body", () => {
  it("bounds an unauthenticated OAuth exchange", async () => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";

    const { request, delivered } = flood("/api/auth/google/exchange");
    const response = await postExchange(request);

    // The status matters less than the number below it: this route is open to
    // anyone, and it used to read all 64 MB before deciding it did not like
    // them.
    expect(delivered()).toBeLessThan(MB);
    expect(response.status).toBe(413);
  });

  it("bounds a share invitation", async () => {
    const owner = upsertUserFromGoogle({
      sub: "sub-1",
      email: "owner@example.com",
      name: "Owner",
      picture: null,
    });
    const profile = createProfile({
      ownerId: owner.id,
      name: "Panto",
      data: { _syncFormatVersion: 1 },
    });

    const { request, delivered } = flood(`/api/profiles/${profile.id}/shares`, {
      sessionToken: createSession(owner.id),
    });
    const response = await postShare(request, routeParams({ id: profile.id }));

    expect(delivered()).toBeLessThan(MB);
    expect(response.status).toBe(413);
  });
});
