#!/usr/bin/env node
/**
 * A throwaway S3-compatible origin for the E2E run.
 *
 * Hosted audio is off unless the five `IMPAMP_S3_*` variables are set, and
 * every earlier E2E only ever asserted what an *unconfigured* deployment
 * answers. So the presigned PUT, the commit that charges quota from what the
 * bucket reports, proof-of-possession and the download URL had no end-to-end
 * exercise at all — the invariant `CLAUDE.md` calls security-critical was
 * tested only against an in-memory fake inside the same process.
 *
 * This server is the missing half: real HTTP, real presigned URLs, real
 * SigV4-signed server-side reads. It stores objects in memory, path-style
 * (`/<bucket>/<key>`), which is the shape `s3/client.ts` mints.
 *
 * It deliberately does **not** verify signatures. Signing is covered
 * exhaustively by `src/lib/server/s3/sigv4.test.ts` against the AWS
 * specification's own vectors; re-implementing the verifier here would only
 * test this file against itself, and a mistake in it would fail every audio
 * test for a reason that has nothing to do with the app. What this server is
 * for is the parts a fake inside the process cannot reach: that a URL the
 * browser is handed is fetchable, that Content-Length comes back from the
 * store rather than the client, and that a Range read returns the bytes the
 * proof check compares.
 *
 * Usage: node e2e-tests/fake-s3.js [port]   (default: E2E_S3_PORT, then 3199)
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** Wide open on purpose: a real bucket needs a CORS rule for the same reason. */
function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,PUT,HEAD,DELETE");
  response.setHeader("Access-Control-Allow-Headers", "*");
  response.setHeader("Access-Control-Expose-Headers", "ETag,Content-Length");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function escapeXml(value) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}

/**
 * ListObjectsV2, including both ways of resuming a listing.
 *
 * `continuation-token` is the opaque one S3 hands back mid-listing, modelled
 * here as the first key of the next page — so it is inclusive. `start-after`
 * is the documented plain-key one, exclusive, and the only resume point that
 * still means something an hour later. S3 ignores `start-after` when a
 * continuation token is present, so this does too.
 */
function listObjectsV2(objects, url) {
  const prefix = url.searchParams.get("prefix") ?? "";
  const maxKeys = Number(url.searchParams.get("max-keys") ?? 1000);
  const after = url.searchParams.get("continuation-token");
  const startAfter = url.searchParams.get("start-after");

  let keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  if (after) keys = keys.filter((key) => key >= after);
  else if (startAfter) keys = keys.filter((key) => key > startAfter);

  const page = keys.slice(0, maxKeys);
  const truncated = keys.length > maxKeys;

  const contents = page
    .map((key) => {
      const object = objects.get(key);
      return `<Contents><Key>${escapeXml(key)}</Key><Size>${
        object.body.byteLength
      }</Size><LastModified>${object.lastModified.toISOString()}</LastModified></Contents>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${
    truncated
      ? `<NextContinuationToken>${escapeXml(keys[maxKeys])}</NextContinuationToken>`
      : ""
  }</ListBucketResult>`;
}

/**
 * A bucket of its own, so a caller can run one per test without a port
 * collision or objects left over from the last one.
 *
 * @returns An unstarted `http.Server`; the caller listens on whichever port
 *   suits it.
 */
export function createFakeS3Server() {
  /** key -> { body: Buffer, contentType: string, lastModified: Date } */
  const objects = new Map();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost`);
    cors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    if (url.pathname === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    // /<bucket>/<key…>. The bucket name is not checked: this server serves
    // exactly one deployment's worth of objects and has nothing else to confuse
    // it with.
    const [, , ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));

    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const xml = listObjectsV2(objects, url);
      response
        .writeHead(200, { "Content-Type": "application/xml" })
        .end(Buffer.from(xml));
      return;
    }

    if (request.method === "PUT") {
      const body = await readBody(request);
      objects.set(key, {
        body,
        contentType:
          request.headers["content-type"] ?? "application/octet-stream",
        lastModified: new Date(),
      });
      response.writeHead(200, { ETag: `"${body.byteLength}"` }).end();
      return;
    }

    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }

    const object = objects.get(key);
    if (!object) {
      response
        .writeHead(404, { "Content-Type": "application/xml" })
        .end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }

    // `response-content-type` is how the download URL pins what the object is
    // served as, whatever the uploader's PUT claimed. Honouring it here is what
    // makes that a testable promise rather than a signed query parameter nobody
    // reads.
    const contentType =
      url.searchParams.get("response-content-type") ?? object.contentType;
    const disposition = url.searchParams.get("response-content-disposition");

    if (request.method === "HEAD") {
      const headers = {
        "Content-Type": contentType,
        "Content-Length": String(object.body.byteLength),
        "Last-Modified": object.lastModified.toUTCString(),
      };
      if (disposition) headers["Content-Disposition"] = disposition;
      response.writeHead(200, headers).end();
      return;
    }

    if (request.method === "GET") {
      const headers = { "Content-Type": contentType };
      if (disposition) headers["Content-Disposition"] = disposition;

      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : object.body.byteLength - 1;
        const slice = object.body.subarray(start, end + 1);
        response
          .writeHead(206, {
            ...headers,
            "Content-Length": String(slice.byteLength),
            "Content-Range": `bytes ${start}-${end}/${object.body.byteLength}`,
          })
          .end(slice);
        return;
      }

      response
        .writeHead(200, {
          ...headers,
          "Content-Length": String(object.body.byteLength),
        })
        .end(object.body);
      return;
    }

    response.writeHead(405).end();
  });

  return server;
}

// Run as a server when invoked directly, which is how playwright.config.ts
// starts it; imported, it is just the factory above.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.argv[2] ?? process.env.E2E_S3_PORT ?? 3199);
  createFakeS3Server().listen(port, () => {
    console.log(`fake S3 listening on ${port}`);
  });
}
