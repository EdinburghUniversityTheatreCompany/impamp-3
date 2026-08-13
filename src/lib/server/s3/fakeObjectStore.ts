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
  /** Every key currently stored. */
  keys(): string[];
  /** Uploads minted but never committed, in call order. */
  uploadUrls: string[];
}

export function createFakeObjectStore(): FakeObjectStore {
  const objects = new Map<string, StoredObject>();
  const uploadUrls: string[] = [];

  return {
    uploadUrls,

    put(key, sizeBytes, contentType = "audio/wav") {
      objects.set(key, { sizeBytes, contentType });
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
