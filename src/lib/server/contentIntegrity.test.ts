/**
 * The content-address check itself, exercised on its own.
 *
 * The route test proves commit refuses mismatched bytes; this proves the
 * arithmetic underneath, which the route test cannot see because every fixture
 * it uses is smaller than one chunk. A digest loop that silently hashed only
 * the first 4 MB of every object would pass every test in `audio.api.test.ts`.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  digestStoredObject,
  storedObjectMatchesHash,
} from "./contentIntegrity";
import type { ObjectStore } from "./s3/client";

const MB = 1024 * 1024;

/** A store that serves one object and records every range it was asked for. */
function storeServing(bytes: Uint8Array | null) {
  const ranges: Array<{ offset: number; length: number }> = [];
  const store = {
    async getRange(_key: string, offset: number, length: number) {
      ranges.push({ offset, length });
      if (!bytes) return null;
      return bytes.slice(offset, offset + length);
    },
  } as unknown as ObjectStore;
  return { store, ranges };
}

function filled(sizeBytes: number): Uint8Array {
  const out = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) out[i] = (i * 31) % 251;
  return out;
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("digestStoredObject", () => {
  it("hashes an object smaller than one chunk in a single read", async () => {
    const bytes = filled(1024);
    const { store, ranges } = storeServing(bytes);

    expect(await digestStoredObject(store, "k", bytes.byteLength)).toBe(
      sha256(bytes),
    );
    expect(ranges).toEqual([{ offset: 0, length: 1024 }]);
  });

  it("hashes an object spanning several chunks, and covers every byte", async () => {
    // 10 MB against a 4 MB chunk: two full reads and a 2 MB remainder. A loop
    // that stopped after the first chunk, or that re-read from zero, would
    // still produce a digest — just not this one.
    const bytes = filled(10 * MB);
    const { store, ranges } = storeServing(bytes);

    expect(await digestStoredObject(store, "k", bytes.byteLength)).toBe(
      sha256(bytes),
    );
    expect(ranges).toEqual([
      { offset: 0, length: 4 * MB },
      { offset: 4 * MB, length: 4 * MB },
      { offset: 8 * MB, length: 2 * MB },
    ]);
  });

  it("reports null when the object is gone rather than hashing nothing", async () => {
    // The digest of zero bytes is a perfectly good hex string, and comparing
    // it against a claimed hash would quietly answer "no" for the right
    // reason. Returning null keeps "absent" distinguishable from "different".
    const { store } = storeServing(null);
    expect(await digestStoredObject(store, "k", 1024)).toBeNull();
  });

  it("reports null on a short read instead of looping for bytes that are not coming", async () => {
    const { store } = storeServing(filled(100));
    expect(await digestStoredObject(store, "k", 4096)).toBeNull();
  });
});

describe("storedObjectMatchesHash", () => {
  it("accepts the digest of the bytes actually held", async () => {
    const bytes = filled(2048);
    const { store } = storeServing(bytes);

    expect(await storedObjectMatchesHash(store, "k", 2048, sha256(bytes))).toBe(
      true,
    );
  });

  it("rejects any other digest", async () => {
    const bytes = filled(2048);
    const { store } = storeServing(bytes);

    expect(
      await storedObjectMatchesHash(store, "k", 2048, sha256(filled(2047))),
    ).toBe(false);
  });
});
