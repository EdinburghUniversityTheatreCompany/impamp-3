import { describe, expect, it, vi } from "vitest";
import { createObjectStore, objectKeyForHash } from "./client";
import type { AudioHostingConfig } from "./config";

const config: AudioHostingConfig = {
  endpoint: "https://s3.eu-central-2.wasabisys.com",
  region: "eu-central-2",
  bucket: "impamp-audio",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  globalCapBytes: 1024,
  defaultUserQuotaBytes: 512,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 3600,
  maxObjectBytes: 256,
};

const HASH = "a".repeat(64);

/**
 * A `fetch` stand-in that always answers `status`. The parameters are declared
 * so `mock.calls` stays typed and the assertions below can read the request.
 */
function respond(status: number, headers: Record<string, string> = {}) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status, headers }),
  );
}

describe("objectKeyForHash", () => {
  it("sits the object under a two-character shard", () => {
    expect(objectKeyForHash(HASH, "wav")).toBe(`audio/aa/${HASH}.wav`);
  });

  it("strips anything that isn't alphanumeric from the extension", () => {
    // A filename like "evil.wav/../../x" must not escape the prefix.
    expect(objectKeyForHash(HASH, "wav/../..")).toBe(`audio/aa/${HASH}.wav`);
  });

  it("copes with no extension at all", () => {
    expect(objectKeyForHash(HASH, "")).toBe(`audio/aa/${HASH}`);
  });
});

describe("presignUpload", () => {
  it("mints a PUT URL against the configured bucket, with an expiry", () => {
    const store = createObjectStore(config, respond(200));
    const url = new URL(store.presignUpload(objectKeyForHash(HASH, "wav")));

    expect(url.host).toBe("s3.eu-central-2.wasabisys.com");
    expect(url.pathname).toBe(`/impamp-audio/audio/aa/${HASH}.wav`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("presignDownload", () => {
  it("pins the response content type so the bucket can't serve HTML", () => {
    const store = createObjectStore(config, respond(200));
    const url = new URL(
      store.presignDownload(objectKeyForHash(HASH, "wav"), {
        contentType: "audio/wav",
      }),
    );

    expect(url.searchParams.get("response-content-type")).toBe("audio/wav");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("strips quotes from a download filename rather than letting it escape", () => {
    const store = createObjectStore(config, respond(200));
    const url = new URL(
      store.presignDownload(objectKeyForHash(HASH, "wav"), {
        downloadName: 'ev"il\r\n.wav',
      }),
    );

    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="evil.wav"',
    );
  });

  it("signs the overridden response type — tampering breaks the signature", () => {
    const store = createObjectStore(config, respond(200));
    const withType = new URL(
      store.presignDownload("audio/aa/x.wav", { contentType: "audio/wav" }),
    );
    const without = new URL(store.presignDownload("audio/aa/x.wav"));

    expect(withType.searchParams.get("X-Amz-Signature")).not.toBe(
      without.searchParams.get("X-Amz-Signature"),
    );
  });
});

describe("head", () => {
  it("reads the real size back", async () => {
    const fetchImpl = respond(200, {
      "content-length": "4096",
      "content-type": "audio/wav",
    });
    const store = createObjectStore(config, fetchImpl);

    expect(await store.head("audio/aa/x.wav")).toEqual({
      sizeBytes: 4096,
      contentType: "audio/wav",
    });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "HEAD" });
  });

  it("sends an Authorization header", async () => {
    const fetchImpl = respond(200, { "content-length": "1" });
    await createObjectStore(config, fetchImpl).head("audio/aa/x.wav");

    const headers = fetchImpl.mock.calls[0][1]!.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("reports a missing object as null rather than throwing", async () => {
    const store = createObjectStore(config, respond(404));
    expect(await store.head("audio/aa/missing.wav")).toBeNull();
  });

  it("throws on a real failure, so a 403 is never read as 'absent'", async () => {
    const store = createObjectStore(config, respond(403));
    await expect(store.head("audio/aa/x.wav")).rejects.toThrow("403");
  });
});

describe("remove", () => {
  it("deletes", async () => {
    const fetchImpl = respond(204);
    await createObjectStore(config, fetchImpl).remove("audio/aa/x.wav");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("treats an already-absent object as success", async () => {
    const store = createObjectStore(config, respond(404));
    await expect(store.remove("audio/aa/x.wav")).resolves.toBeUndefined();
  });

  it("surfaces a refused delete", async () => {
    const store = createObjectStore(config, respond(403));
    await expect(store.remove("audio/aa/x.wav")).rejects.toThrow("403");
  });
});
