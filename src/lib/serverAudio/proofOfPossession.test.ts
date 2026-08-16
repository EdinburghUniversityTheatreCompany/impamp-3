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

  it("keeps the window inside the file", () => {
    const size = 300 * 1024;
    const range = proofRangeFor(HASH, size);

    expect(range.offset).toBeGreaterThanOrEqual(0);
    expect(range.offset + range.length).toBeLessThanOrEqual(size);
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
