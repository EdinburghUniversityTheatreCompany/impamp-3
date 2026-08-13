/**
 * The four object-storage operations audio hosting needs, over SigV4.
 *
 * Uploads and downloads never pass through this server: it mints a short-lived
 * presigned URL and the browser talks to the bucket directly. That keeps audio
 * bytes off a single-instance Next.js deployment whose SQLite layer is
 * synchronous, and keeps Wasabi's egress accounting between the browser and
 * the bucket.
 *
 * Server-only.
 */

import { presignUrl, signRequestHeaders, uriEncode } from "./sigv4";
import type { AudioHostingConfig } from "./config";

export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
}

/**
 * The storage surface the rest of the app depends on. Route handlers take this
 * interface rather than the concrete client so tests can substitute a fake
 * without a network or credentials — see `fakeObjectStore.ts`.
 */
export interface ObjectStore {
  /** A URL the browser may PUT exactly one object to. */
  presignUpload(key: string): string;
  /** A URL the browser may GET the object from. */
  presignDownload(
    key: string,
    options?: { contentType?: string; downloadName?: string },
  ): string;
  /** The object's real size, or `null` if it isn't there. */
  head(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
}

/**
 * Content-addressed key: identical audio uploaded by two people is one object.
 * The two-character shard keeps bucket listings navigable.
 */
export function objectKeyForHash(hash: string, extension: string): string {
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const suffix = safeExtension ? `.${safeExtension}` : "";
  return `audio/${hash.slice(0, 2)}/${hash}${suffix}`;
}

export function createObjectStore(
  config: AudioHostingConfig,
  // Injected so tests can assert on the request without a network.
  fetchImpl: typeof fetch = fetch,
): ObjectStore {
  const signing = {
    region: config.region,
    service: "s3",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };

  const urlFor = (key: string) =>
    `${config.endpoint}/${uriEncode(config.bucket)}/${uriEncode(key, {
      encodeSlash: false,
    })}`;

  return {
    presignUpload(key) {
      // Only `host` is signed, so the URL does not constrain what the browser
      // actually sends. The size that lands is established with a HEAD at
      // commit time, and that is the number quota is charged against — a
      // client cannot under-declare its way past the cap.
      return presignUrl({
        ...signing,
        method: "PUT",
        url: urlFor(key),
        expiresIn: config.uploadUrlTtlSeconds,
      });
    },

    presignDownload(key, { contentType, downloadName } = {}) {
      const query: Record<string, string> = {};
      // Force the response type from what we recorded, rather than trusting
      // whatever Content-Type the uploader's PUT happened to set. Without
      // this, someone approved for audio could park an HTML file in the
      // bucket and get it served as text/html from the bucket's own origin.
      if (contentType) query["response-content-type"] = contentType;
      if (downloadName) {
        query["response-content-disposition"] =
          `attachment; filename="${downloadName.replace(/["\\\r\n]/g, "")}"`;
      }

      return presignUrl({
        ...signing,
        method: "GET",
        url: urlFor(key),
        expiresIn: config.downloadUrlTtlSeconds,
        query,
      });
    },

    async head(key) {
      const url = urlFor(key);
      const response = await fetchImpl(url, {
        method: "HEAD",
        headers: signRequestHeaders({ ...signing, method: "HEAD", url }),
      });

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`HEAD ${key} failed with ${response.status}`);
      }

      const length = response.headers.get("content-length");
      return {
        sizeBytes: length ? Number(length) : 0,
        contentType: response.headers.get("content-type"),
      };
    },

    async remove(key) {
      const url = urlFor(key);
      const response = await fetchImpl(url, {
        method: "DELETE",
        headers: signRequestHeaders({ ...signing, method: "DELETE", url }),
      });
      // S3 answers 204 for a delete, and also for a key that was never there.
      if (!response.ok && response.status !== 404) {
        throw new Error(`DELETE ${key} failed with ${response.status}`);
      }
    },
  };
}
