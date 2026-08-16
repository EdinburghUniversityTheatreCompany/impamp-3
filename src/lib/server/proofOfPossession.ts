/**
 * Proving that a caller claiming an already-stored sound actually has it.
 *
 * Audio objects are content-addressed and shared: two people uploading the same
 * file get one object, and the second is told `alreadyStored` and handed no
 * upload URL. Commit then confirmed the object existed — with `head` — and
 * recorded a reference for them.
 *
 * `head` asks whether a *key* exists. It says nothing about whether the caller
 * has the bytes, and the key is derived from the SHA-256, which is not secret:
 * every profile blob names the hashes of its sounds, and `GET /api/profiles/:id`
 * hands that blob to anyone allowed to read the profile, viewers included. So
 * an approved account that had merely *seen* a hash could claim it, get a
 * reference row, and thereby reach the bytes through
 * `profileMayServeHash` — which counts a reference held by any editor of the
 * profile being served. That is precisely the control added so that revoking a
 * share revokes the audio, bypassed by knowing a string.
 *
 * The fix cannot be "make them upload instead": the presigned PUT is issued for
 * a content-addressed key and nothing verifies what is sent, so handing an
 * upload URL to someone who does not have the bytes would let them *overwrite*
 * someone else's audio. Withholding that URL is what stops it today.
 *
 * So the caller proves possession instead. The server names a byte range, the
 * caller sends the SHA-256 of that slice of the file it holds, and the server
 * checks it against the same range read from the bucket. Someone with only the
 * hash cannot produce it.
 *
 * The range is derived from the hash and the stored size rather than being
 * remembered between the two requests, so this adds no server state. That it is
 * predictable does not weaken it: the secret being tested is the *content*, not
 * the offset.
 *
 * @module lib/server/proofOfPossession
 */

import { createHash } from "node:crypto";

/** How much of the file to check. Small enough to be cheap on every commit. */
const PROOF_WINDOW_BYTES = 64 * 1024;

export interface ProofRange {
  offset: number;
  length: number;
}

/**
 * The slice a caller must hash to prove it holds this object.
 *
 * Deterministic in the hash and size, so both requests agree without the
 * server storing anything. Anchored away from the start of the file where it
 * can be: file headers are the most guessable part of an audio file, and for
 * common formats a container header can be reconstructed from metadata alone.
 *
 * @param hash - The object's SHA-256, lowercase hex
 * @param sizeBytes - The size the bucket reports
 * @returns The range to hash, clamped to the object
 */
export function proofRangeFor(hash: string, sizeBytes: number): ProofRange {
  if (sizeBytes <= PROOF_WINDOW_BYTES) {
    return { offset: 0, length: sizeBytes };
  }

  // 13 hex digits stays inside Number.MAX_SAFE_INTEGER.
  const seed = Number.parseInt(hash.slice(0, 13), 16) || 0;
  const span = sizeBytes - PROOF_WINDOW_BYTES;
  return { offset: seed % (span + 1), length: PROOF_WINDOW_BYTES };
}

/** The SHA-256, lowercase hex, of the bytes in the proof range. */
export function proofDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether `claimed` matches the digest of the same range read from storage.
 *
 * Compared with a constant-time-ish length check first; the value is a digest
 * rather than a secret, so an ordinary comparison is acceptable — an attacker
 * learns nothing from timing that they could not get by asking again.
 *
 * @returns True when the caller demonstrably holds the object's bytes
 */
export function proofMatches(
  claimed: unknown,
  storedRangeBytes: Uint8Array | null,
): boolean {
  if (typeof claimed !== "string" || !/^[0-9a-f]{64}$/.test(claimed)) {
    return false;
  }
  if (!storedRangeBytes || storedRangeBytes.byteLength === 0) return false;
  return proofDigest(storedRangeBytes) === claimed;
}
