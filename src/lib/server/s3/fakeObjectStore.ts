/**
 * An in-memory ObjectStore for tests: no network, no credentials, no bucket.
 *
 * Presigned URLs are fabricated but shaped like the real ones (an absolute
 * URL carrying an expiry), so code under test can assert on them without
 * caring which storage provider is behind it.
 */

import type { ObjectStore, StoredObject } from "./client";

export interface FakeObjectStore extends ObjectStore {
  /** Pretend the browser completed a PUT of `sizeBytes` to `key`. */
  put(key: string, sizeBytes: number, contentType?: string): void;
  /** Store real bytes, so proof-of-possession checks can be exercised. */
  putBytes(key: string, bytes: Uint8Array, contentType?: string): void;
  /** Backdate an object, so the sweep's grace period can be exercised. */
  setLastModified(key: string, lastModifiedMs: number): void;
  /** Every key currently stored. */
  keys(): string[];
  /** Uploads minted but never committed, in call order. */
  uploadUrls: string[];
}

export function createFakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, StoredObject>();
  const bytes = new Map<string, Uint8Array>();
  const lastModified = new Map<string, number>();
  const uploadUrls: string[] = [];

  return {
    uploadUrls,

    put(key, sizeBytes, contentType = "audio/wav") {
      objects.set(key, { sizeBytes, contentType });
      lastModified.set(key, Date.now());
    },

    putBytes(key, content, contentType = "audio/wav") {
      objects.set(key, { sizeBytes: content.byteLength, contentType });
      bytes.set(key, content);
      lastModified.set(key, Date.now());
    },

    setLastModified(key, ms) {
      lastModified.set(key, ms);
    },

    // `continuationToken` is modelled as the first key of the next page, so
    // it is inclusive; `start-after` is a plain key and exclusive. Both match
    // what `e2e-tests/fake-s3.js` does over real HTTP, and a token wins over
    // `startAfter` the way S3's does.
    async list({ prefix, continuationToken, startAfter, maxKeys = 1000 }) {
      let all = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1));

      if (continuationToken) {
        all = all.filter(([key]) => key >= continuationToken);
      } else if (startAfter) {
        all = all.filter(([key]) => key > startAfter);
      }

      const page = all.slice(0, maxKeys);
      const next = all[maxKeys];

      return {
        objects: page.map(([key, object]) => ({
          key,
          sizeBytes: object.sizeBytes,
          lastModifiedMs: lastModified.get(key) ?? Date.now(),
        })),
        nextContinuationToken: next ? next[0] : null,
      };
    },

    async getRange(key, offset, length) {
      const content = bytes.get(key);
      if (!content) return objects.has(key) ? new Uint8Array(0) : null;
      return content.slice(offset, offset + length);
    },

    keys() {
      return [...objects.keys()].sort();
    },

    presignUpload(key) {
      const url = `https://fake-bucket.test/${key}?upload=1&expires=900`;
      uploadUrls.push(url);
      return url;
    },

    presignDownload(key, { contentType, downloadName } = {}) {
      const params = new URLSearchParams({ download: "1", expires: "3600" });
      if (contentType) params.set("response-content-type", contentType);
      if (downloadName) params.set("filename", downloadName);
      return `https://fake-bucket.test/${key}?${params}`;
    },

    async head(key) {
      return objects.get(key) ?? null;
    },

    async remove(key) {
      objects.delete(key);
    },
  };
}
