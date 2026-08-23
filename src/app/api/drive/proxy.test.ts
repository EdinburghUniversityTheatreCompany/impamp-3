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
import { resetRateLimitState } from "@/lib/server/rateLimit";

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
  resetRateLimitState();
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

describe("rate limiting", () => {
  /**
   * A request that looks like it came through kamal-proxy. The other tests in
   * this file deliberately send no forwarding header, which is how a dev or
   * E2E request looks — the limiter stands down for those, so they are
   * unaffected by anything here.
   */
  function fromClient(address: string) {
    return new NextRequest(
      `http://localhost/api/drive/public-file?id=${FILE_ID}`,
      {
        headers: {
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": `10.0.0.1, ${address}`,
        },
      },
    );
  }

  /**
   * A fresh Response per call — a body can only be consumed once, and these
   * tests make hundreds of requests through the same mock.
   */
  function jsonFile() {
    fetchWithTimeout.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
  }

  it("refuses a client past the limit, with a Retry-After", async () => {
    jsonFile();
    const { LIMITS } = await import("@/lib/server/rateLimit");

    for (let i = 0; i < LIMITS.driveProxy.limit; i++) {
      expect((await getFile(fromClient("203.0.113.5"))).status).toBe(200);
    }

    const refused = await getFile(fromClient("203.0.113.5"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts the proxy-supplied address, not one the caller invented", async () => {
    jsonFile();
    const { LIMITS } = await import("@/lib/server/rateLimit");

    // Every request claims a different leftmost hop. Keying on that would
    // hand one script an unlimited number of identities.
    for (let i = 0; i < LIMITS.driveProxy.limit; i++) {
      const spoofed = new NextRequest(
        `http://localhost/api/drive/public-file?id=${FILE_ID}`,
        {
          headers: {
            "sec-fetch-site": "same-origin",
            "x-forwarded-for": `10.0.0.${i % 250}, 203.0.113.6`,
          },
        },
      );
      expect((await getFile(spoofed)).status).toBe(200);
    }

    expect((await getFile(fromClient("203.0.113.6"))).status).toBe(429);
  });

  it("leaves a different client's budget alone", async () => {
    jsonFile();
    const { LIMITS } = await import("@/lib/server/rateLimit");

    for (let i = 0; i < LIMITS.driveProxy.limit; i++) {
      await getFile(fromClient("203.0.113.7"));
    }
    expect((await getFile(fromClient("203.0.113.7"))).status).toBe(429);
    expect((await getFile(fromClient("203.0.113.8"))).status).toBe(200);
  });

  it("does not limit a request with nothing in front of it", async () => {
    jsonFile();
    const { LIMITS } = await import("@/lib/server/rateLimit");

    // The dev server and the E2E run. Bucketing these together would let one
    // caller lock out every other, which is worse than not limiting.
    for (let i = 0; i < LIMITS.driveProxy.limit + 5; i++) {
      const bare = new NextRequest(
        `http://localhost/api/drive/public-file?id=${FILE_ID}`,
        { headers: { "sec-fetch-site": "same-origin" } },
      );
      expect((await getFile(bare)).status).toBe(200);
    }
  });

  it("refuses before spending the API key", async () => {
    jsonFile();
    const { LIMITS } = await import("@/lib/server/rateLimit");

    for (let i = 0; i < LIMITS.driveProxy.limit; i++) {
      await getFile(fromClient("203.0.113.9"));
    }
    const callsBefore = fetchWithTimeout.mock.calls.length;

    await getFile(fromClient("203.0.113.9"));

    // The whole point: a refused request must not reach Google. A limiter
    // placed after the fetch would bound the response and not the cost.
    expect(fetchWithTimeout.mock.calls.length).toBe(callsBefore);
  });
});
