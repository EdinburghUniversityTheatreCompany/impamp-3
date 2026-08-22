/**
 * What the public Drive proxies are willing to hand back.
 *
 * The audio route reads a file's `mimeType` from Drive and sends it on as the
 * response `Content-Type`. That string is chosen by whoever uploaded the file
 * to Drive, not by this app — so it is attacker-influenced input on a route
 * that streams up to 100 MB from this deployment's own origin. Accepting any
 * `audio/…` prefix and repeating it verbatim, with nothing to stop a browser
 * sniffing past it, is the shape a proxy turns into a content-injection
 * vector. The `Sec-Fetch-Site` gate makes it hard to reach, which is why this
 * is defence in depth rather than a hole; it is also why it needs a test of
 * its own, because neither route had one at all.
 *
 * Both routes live in one file because both mock the same `fetchWithTimeout`
 * and answer the same question about the same header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchWithTimeout = vi.fn();
vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchWithTimeout(...args),
}));

const { GET } = await import("./public-audio/route");
const { GET: getFile } = await import("./public-file/route");

const FILE_ID = "1AbC_def-123";

beforeEach(() => {
  process.env.GOOGLE_API_KEY = "test-key";
  fetchWithTimeout.mockReset();
});

afterEach(() => {
  delete process.env.GOOGLE_API_KEY;
});

/** A same-origin request, which is the only kind the proxy answers at all. */
function proxyRequest() {
  return new NextRequest(
    `http://localhost/api/drive/public-audio?id=${FILE_ID}`,
    { headers: { "sec-fetch-site": "same-origin" } },
  );
}

/** Drive's two answers: the metadata probe, then the bytes. */
function driveAnswers(mimeType: string, body = "RIFF....WAVEfmt ") {
  fetchWithTimeout
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ mimeType, size: String(body.length) }), {
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(new Response(body));
}

describe("the public audio proxy's Content-Type", () => {
  it("serves an ordinary audio file with the type it was stored under", async () => {
    driveAnswers("audio/mpeg");

    const response = await GET(proxyRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("tells the browser not to sniff past the type it was given", async () => {
    driveAnswers("audio/mpeg");

    const response = await GET(proxyRequest());

    // Without this the declared type is a suggestion: a browser that decides
    // the bytes look like something else renders them as that instead, from
    // this app's own origin.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses a type it would not know how to serve, rather than echoing it", async () => {
    // `audio/` is a prefix anybody can put in front of anything when they
    // upload to Drive; it says nothing about what the bytes are.
    driveAnswers("audio/x-whatever-the-uploader-typed");

    const response = await GET(proxyRequest());

    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("still accepts the container types Drive reports for ogg", async () => {
    // Drive labels .ogg as application/ogg rather than audio/ogg, and the
    // route has always accepted it. An allow-list that dropped it would take
    // working audio away from view-only listeners.
    driveAnswers("application/ogg");

    const response = await GET(proxyRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/ogg");
  });

  it("refuses a non-audio file", async () => {
    driveAnswers("text/html");

    const response = await GET(proxyRequest());

    expect(response.status).toBe(415);
  });
});

describe("the public file proxy", () => {
  it("tells the browser not to sniff past the type it declares", async () => {
    // Its type is this app's own — the body is re-serialised JSON — but the
    // bytes are still a stranger's, fetched with the deployment's API key.
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "a profile" })),
    );

    const response = await getFile(
      new NextRequest("http://localhost/api/drive/public-file?id=abc123", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
