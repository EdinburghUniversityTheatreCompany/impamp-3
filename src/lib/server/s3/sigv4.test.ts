/**
 * The signer is checked against reference signatures produced by botocore —
 * AWS's own Python implementation — rather than against values this codebase
 * computed for itself. Regenerate with:
 *
 *   uv run --with botocore python scripts/generate-sigv4-vectors.py \
 *     > src/lib/server/s3/__fixtures__/sigv4-vectors.json
 *
 * The generator freezes the clock, so a regenerated fixture should be
 * byte-identical unless the signing rules themselves changed.
 */

import { describe, expect, it } from "vitest";
import vectors from "./__fixtures__/sigv4-vectors.json";
import { presignUrl, signRequestHeaders, uriEncode } from "./sigv4";

const credentials = {
  accessKeyId: vectors.accessKeyId,
  secretAccessKey: vectors.secretAccessKey,
};

const signing = {
  region: vectors.region,
  service: vectors.service,
  credentials,
  // "20260814T101112Z" — the instant the fixture was generated at.
  date: new Date(
    Date.UTC(
      Number(vectors.timestamp.slice(0, 4)),
      Number(vectors.timestamp.slice(4, 6)) - 1,
      Number(vectors.timestamp.slice(6, 8)),
      Number(vectors.timestamp.slice(9, 11)),
      Number(vectors.timestamp.slice(11, 13)),
      Number(vectors.timestamp.slice(13, 15)),
    ),
  ),
};

/**
 * Compares two URLs by their meaning rather than their spelling: query
 * parameter order carries no significance to S3, but every value — above all
 * X-Amz-Signature — must match exactly.
 */
function expectSameUrl(actual: string, expected: string) {
  const a = new URL(actual);
  const b = new URL(expected);
  expect(a.origin).toBe(b.origin);
  expect(a.pathname).toBe(b.pathname);
  expect([...a.searchParams.entries()].sort()).toEqual(
    [...b.searchParams.entries()].sort(),
  );
}

describe("uriEncode", () => {
  it("leaves the unreserved set alone", () => {
    expect(uriEncode("aZ09-_.~")).toBe("aZ09-_.~");
  });

  it("encodes the characters encodeURIComponent misses", () => {
    // encodeURIComponent leaves ! ' ( ) * alone; SigV4 requires them encoded,
    // and a signature computed without this is silently wrong.
    expect(uriEncode("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("percent-encodes spaces as %20, never as +", () => {
    expect(uriEncode("pad one")).toBe("pad%20one");
  });

  it("encodes non-ASCII as UTF-8 bytes", () => {
    expect(uriEncode("café")).toBe("caf%C3%A9");
  });

  it("keeps slashes in a path but encodes them in a value", () => {
    expect(uriEncode("a/b", { encodeSlash: false })).toBe("a/b");
    expect(uriEncode("a/b")).toBe("a%2Fb");
  });
});

describe("presignUrl", () => {
  it("matches botocore for a GET", () => {
    expectSameUrl(
      presignUrl({
        ...signing,
        method: "GET",
        url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
        expiresIn: 900,
      }),
      vectors.presignedGet,
    );
  });

  it("matches botocore for a PUT with a different expiry", () => {
    expectSameUrl(
      presignUrl({
        ...signing,
        method: "PUT",
        url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
        expiresIn: 300,
      }),
      vectors.presignedPut,
    );
  });

  it("matches botocore for a key containing spaces and non-ASCII", () => {
    expectSameUrl(
      presignUrl({
        ...signing,
        method: "GET",
        url: `${vectors.endpoint}/${vectors.bucket}/${uriEncode(
          "audio/pad one/café (1).wav",
          { encodeSlash: false },
        )}`,
        expiresIn: 900,
      }),
      vectors.presignedGetWithSpaceAndUnicode,
    );
  });

  it("matches botocore when the URL already carries a query parameter", () => {
    expectSameUrl(
      presignUrl({
        ...signing,
        method: "GET",
        url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
        query: { "response-content-type": "audio/wav" },
        expiresIn: 900,
      }),
      vectors.presignedGetWithQuery,
    );
  });

  it("expires at the requested offset", () => {
    const url = new URL(
      presignUrl({
        ...signing,
        method: "GET",
        url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
        expiresIn: 42,
      }),
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("42");
  });
});

describe("signRequestHeaders", () => {
  it("matches botocore for a HEAD", () => {
    const headers = signRequestHeaders({
      ...signing,
      method: "HEAD",
      url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
    });
    expect(headers.Authorization).toBe(vectors.headHeaders.Authorization);
    expect(headers["x-amz-date"]).toBe(vectors.headHeaders["X-Amz-Date"]);
    expect(headers["x-amz-content-sha256"]).toBe(
      vectors.headHeaders["X-Amz-Content-SHA256"],
    );
  });

  it("matches botocore for a DELETE", () => {
    const headers = signRequestHeaders({
      ...signing,
      method: "DELETE",
      url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
    });
    expect(headers.Authorization).toBe(vectors.deleteHeaders.Authorization);
  });

  it("signs a different method to a different signature", () => {
    const head = signRequestHeaders({
      ...signing,
      method: "HEAD",
      url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
    });
    const del = signRequestHeaders({
      ...signing,
      method: "DELETE",
      url: `${vectors.endpoint}/${vectors.bucket}/audio/ab/abc123.wav`,
    });
    expect(head.Authorization).not.toBe(del.Authorization);
  });
});
