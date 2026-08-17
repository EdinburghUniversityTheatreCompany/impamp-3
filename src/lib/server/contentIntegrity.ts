/**
 * Checking that a bucket object really is the bytes its key claims.
 *
 * The bucket is content-addressed: `objectKeyForHash` derives the key from the
 * SHA-256 of the file, so "key implies contents" is the invariant everything
 * else rests on. Nothing enforced it. A presigned PUT signs only `host`
 * (`s3/client.ts`), so the upload URL cannot constrain what the browser sends,
 * and commit only ever asked `head` whether the key existed.
 *
 * That is worse than it sounds, because it inverts proof of possession.
 * `proofOfPossession.ts` tests a caller against *the bucket's copy* — "the
 * secret being tested is the content". Let a caller choose what lives at a
 * hash and the poisoner becomes the only party who can pass that test, while
 * everyone holding the real file is refused. So the one check that has to
 * happen server-side, from what the bucket actually holds, is this one.
 *
 * It runs once per distinct object ever stored, not once per commit, and it is
 * bounded by `maxObjectBytes`.
 *
 * Server-only.
 */

import { createHash } from "node:crypto";
import type { ObjectStore } from "./s3/client";

/**
 * How much of an object to pull into memory at a time.
 *
 * The whole object has to be read to hash it, but it does not have to be
 * resident: this is a single-instance deployment whose SQLite layer is
 * synchronous, and a 100 MB `arrayBuffer()` on the request thread is exactly
 * the sort of allocation that stalls every other user.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * The SHA-256 of an object as the bucket currently holds it.
 *
 * @param store - The object store to read through
 * @param key - The object's key
 * @param sizeBytes - The size the bucket reported, from `head`
 * @returns The lowercase hex digest, or `null` if the object went away or
 *   returned fewer bytes than it claimed
 */
export async function digestStoredObject(
  store: ObjectStore,
  key: string,
  sizeBytes: number,
): Promise<string | null> {
  const digest = createHash("sha256");

  for (let offset = 0; offset < sizeBytes; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, sizeBytes - offset);
    const chunk = await store.getRange(key, offset, length);
    // A short or empty read means the object is not what `head` described —
    // it was replaced or removed mid-check. Never loop waiting for bytes that
    // are not coming.
    if (!chunk || chunk.byteLength === 0) return null;
    digest.update(chunk);
    if (chunk.byteLength < length) return null;
  }

  return digest.digest("hex");
}

/** Whether the bucket's copy of `key` hashes to `hash`. */
export async function storedObjectMatchesHash(
  store: ObjectStore,
  key: string,
  sizeBytes: number,
  hash: string,
): Promise<boolean> {
  return (await digestStoredObject(store, key, sizeBytes)) === hash;
}
