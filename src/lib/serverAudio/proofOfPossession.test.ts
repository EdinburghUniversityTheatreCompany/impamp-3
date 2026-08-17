/**
 * The browser's answer has to satisfy the server's check.
 *
 * These are two implementations of one rule — the client slices a `Blob` and
 * hashes with WebCrypto, the server slices bucket bytes and hashes with
 * `node:crypto` — which is the shape of defect this codebase keeps producing.
 * So they are tested against each other rather than each against its own idea
 * of the answer.
 */
import { describe, expect, it } from "vitest";
import { proofOfPossession } from "./proofOfPossession";
import {
  proofDigest,
  proofMatches,
  proofRangeFor,
} from "@/lib/server/proofOfPossession";

const HASH = "c0ffee".padEnd(64, "a");

/** Deterministic bytes standing in for an audio file. */
function fileBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  return bytes;
}

describe("proof of possession, client against server", () => {
  it.each([
    ["a file smaller than the window", 1024],
    ["a file exactly the window", 64 * 1024],
    ["a file larger than the window", 300 * 1024],
  ])("agrees on %s", async (_label, size) => {
    const bytes = fileBytes(size);
    const range = proofRangeFor(HASH, size);

    const fromClient = await proofOfPossession(new Blob([bytes]), range);
    const fromServer = proofDigest(
      bytes.slice(range.offset, range.offset + range.length),
    );

    expect(fromClient).toBe(fromServer);
    expect(
      proofMatches(
        fromClient,
        bytes.slice(range.offset, range.offset + range.length),
      ),
    ).toBe(true);
  });

  it("does not accept the bytes of a different file", async () => {
    const size = 4096;
    const range = proofRangeFor(HASH, size);
    const theirs = fileBytes(size);
    const mine = fileBytes(size).map((b) => b ^ 0xff);

    const claimed = await proofOfPossession(new Blob([mine]), range);

    expect(
      proofMatches(
        claimed,
        theirs.slice(range.offset, range.offset + range.length),
      ),
    ).toBe(false);
  });

  it("rejects anything that is not a sha-256 hex digest", () => {
    const bytes = fileBytes(64);
    expect(proofMatches(undefined, bytes)).toBe(false);
    expect(proofMatches("", bytes)).toBe(false);
    expect(proofMatches("not-hex".padEnd(64, "z"), bytes)).toBe(false);
    // Right shape, wrong value.
    expect(proofMatches("a".repeat(64), bytes)).toBe(false);
  });

  it("refuses when storage returned nothing", () => {
    // A missing object must never read as a satisfied challenge.
    expect(proofMatches("a".repeat(64), null)).toBe(false);
    expect(proofMatches("a".repeat(64), new Uint8Array(0))).toBe(false);
  });
});

/**
 * The offset arithmetic, over the space it actually runs on.
 *
 * A single fixture cannot test a modulo. The one that used to stand here —
 * `offset >= 0` and `offset + length <= size` for one hardcoded hash at one
 * size — held by coincidence: with `span` computed as `size + WINDOW` instead
 * of `size - WINDOW`, that hash still lands inside, while 37 % of hashes would
 * push the window past the end of the file. Nothing else in the repo executes
 * this branch, because every integration fixture is smaller than the window.
 */
describe("proofRangeFor", () => {
  const WINDOW = 64 * 1024;

  /** A thousand distinct, deterministic 64-hex-digit hashes. */
  const hashes = Array.from({ length: 1000 }, (_, i) =>
    proofDigest(new TextEncoder().encode(`hash-${i}`)),
  );

  const SIZES = [
    WINDOW + 1,
    WINDOW + 7,
    100 * 1024,
    300 * 1024,
    5 * 1024 * 1024,
    97_654_321,
  ];

  it("names a full window that lies wholly inside the file", () => {
    for (const size of SIZES) {
      for (const hash of hashes) {
        const range = proofRangeFor(hash, size);
        expect(range.length, `${hash} @ ${size}`).toBe(WINDOW);
        expect(range.offset, `${hash} @ ${size}`).toBeGreaterThanOrEqual(0);
        expect(range.offset, `${hash} @ ${size}`).toBeLessThanOrEqual(
          size - WINDOW,
        );
      }
    }
  });

  it("hashes the whole of a file no bigger than the window", () => {
    for (const size of [0, 1, 4096, WINDOW - 1, WINDOW]) {
      for (const hash of hashes.slice(0, 20)) {
        expect(proofRangeFor(hash, size), `${hash} @ ${size}`).toEqual({
          offset: 0,
          length: size,
        });
      }
    }
  });

  it("gives the same answer both times it is asked", () => {
    // The range is recomputed at commit rather than remembered from the
    // upload-url response, so the two requests agree only if this is a pure
    // function of the hash and the size.
    for (const hash of hashes.slice(0, 50)) {
      expect(proofRangeFor(hash, 300 * 1024)).toEqual(
        proofRangeFor(hash, 300 * 1024),
      );
    }
  });

  it("anchors away from the start of the file", () => {
    // The docblock spends a paragraph justifying this: a file header is the
    // most guessable part of an audio file, and for common containers it can
    // be reconstructed from metadata alone. Pinning the window at 0 would
    // quietly degrade the check to "hash the first 64 KB".
    const size = 5 * 1024 * 1024;
    const offsets = hashes.map((hash) => proofRangeFor(hash, size).offset);

    expect(new Set(offsets).size).toBeGreaterThan(900);
    expect(offsets.filter((offset) => offset === 0)).toHaveLength(0);
    expect(Math.max(...offsets)).toBeGreaterThan(size / 2);
  });

  it("moves the window when the file changes size", () => {
    // Same bytes claimed under two sizes must not challenge the same slice,
    // or a caller who once learned one window's digest could reuse it.
    const [hash] = hashes;
    expect(proofRangeFor(hash, 300 * 1024).offset).not.toBe(
      proofRangeFor(hash, 301 * 1024).offset,
    );
  });
});
