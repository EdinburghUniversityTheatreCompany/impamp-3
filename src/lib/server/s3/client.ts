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

/** One entry of a bucket listing. */
export interface ListedObject {
  key: string;
  sizeBytes: number;
  /** When the bucket says the object was last written, in epoch ms. */
  lastModifiedMs: number;
}

export interface ListOptions {
  prefix: string;
  /**
   * Continues a previous page.
   *
   * Opaque, and only meaningful inside the listing that produced it — so it
   * is for paging within one pass, never for resuming hours later.
   */
  continuationToken?: string;
  /**
   * Start the listing after this key, exclusive.
   *
   * The durable half of the pair: a plain key, so it still names a position
   * in the bucket long after the listing that saw it ended, and it needs no
   * cooperation from the store to remain valid. This is how the sweep resumes
   * where its last pass stopped. S3 ignores it when a continuation token is
   * given as well, so callers send one or the other.
   */
  startAfter?: string;
  maxKeys?: number;
}

export interface ListPage {
  objects: ListedObject[];
  /** Non-null when the bucket has more to give. */
  nextContinuationToken: string | null;
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
  /**
   * A byte range of the object, or `null` if it isn't there.
   *
   * Used to check that a caller claiming an already-stored object actually has
   * its bytes — see `proofOfPossession.ts`. Deliberately a range rather than
   * the whole object: the check has to be cheap enough to run on every
   * deduplicated commit.
   */
  getRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  /**
   * One page of keys under a prefix.
   *
   * The only reader is the sweep that removes objects a browser PUT and never
   * committed (`audioSweep.ts`). Without it those bytes are unreachable
   * forever: no `audio_objects` row means no quota counts them, no admin view
   * shows them and no API can delete them, while Wasabi bills a 90-day minimum
   * for each.
   */
  list(options: ListOptions): Promise<ListPage>;
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

/** The text of the first `<name>` element in `xml`, if any. */
function firstTag(xml: string, name: string): string | null {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * Read a ListObjectsV2 response.
 *
 * Hand-parsed for the same reason SigV4 is hand-rolled: this is one
 * well-specified document with three fields worth reading, against forty
 * transitive packages of AWS SDK. Anything unrecognised yields no entries
 * rather than throwing — a sweep that crashes is worse than a sweep that
 * removes nothing.
 */
export function parseListObjectsV2(xml: string): ListPage {
  const objects: ListedObject[] = [];

  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const key = firstTag(block, "Key");
    if (!key) continue;
    objects.push({
      key: decodeXmlText(key),
      sizeBytes: Number(firstTag(block, "Size") ?? 0),
      lastModifiedMs: Date.parse(firstTag(block, "LastModified") ?? ""),
    });
  }

  const truncated = firstTag(xml, "IsTruncated") === "true";
  return {
    objects,
    nextContinuationToken: truncated
      ? (firstTag(xml, "NextContinuationToken") ?? null)
      : null,
  };
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

    async getRange(key, offset, length) {
      if (length <= 0) return new Uint8Array(0);

      const url = urlFor(key);
      const last = offset + length - 1;
      const range = `bytes=${offset}-${last}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          ...signRequestHeaders({ ...signing, method: "GET", url }),
          range,
        },
      });

      if (response.status === 404) return null;
      // 206 for an honoured range; 200 means the store ignored it and sent the
      // whole object, which is still usable — the caller slices what it needs.
      if (!response.ok) {
        throw new Error(`GET ${key} (${range}) failed with ${response.status}`);
      }

      const body = new Uint8Array(await response.arrayBuffer());
      return response.status === 200
        ? body.slice(offset, offset + length)
        : body;
    },

    async list({ prefix, continuationToken, startAfter, maxKeys = 1000 }) {
      // The bucket itself, not an object under it — so this is the one request
      // whose signature covers a query string.
      const url = new URL(`${config.endpoint}/${uriEncode(config.bucket)}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(maxKeys));
      if (continuationToken) {
        url.searchParams.set("continuation-token", continuationToken);
      } else if (startAfter) {
        url.searchParams.set("start-after", startAfter);
      }

      const target = url.toString();
      const response = await fetchImpl(target, {
        method: "GET",
        headers: signRequestHeaders({
          ...signing,
          method: "GET",
          url: target,
        }),
      });

      if (!response.ok) {
        throw new Error(`LIST ${prefix} failed with ${response.status}`);
      }

      return parseListObjectsV2(await response.text());
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
