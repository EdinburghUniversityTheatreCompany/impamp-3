/**
 * The browser half of the hosted-audio possession check.
 *
 * When the server already holds these exact bytes it hands back no upload URL —
 * there is nothing to send, and issuing one would let a caller overwrite
 * somebody else's audio at a content-addressed key. Instead it names a byte
 * range, and this returns the SHA-256 of that slice of the local file, which
 * only a device that really has the file can produce.
 *
 * @module lib/serverAudio/proofOfPossession
 */

/**
 * Hashes the requested slice of a local audio blob.
 *
 * `blob.slice` is a view rather than a copy, so only the window is read into
 * memory — this runs on every deduplicated upload and must not materialise a
 * whole audio file to answer.
 *
 * @param blob - The local audio bytes
 * @param range - The window the server asked about
 * @returns Lowercase hex SHA-256 of that window
 */
export async function proofOfPossession(
  blob: Blob,
  range: { offset: number; length: number },
): Promise<string> {
  const window = blob.slice(range.offset, range.offset + range.length);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await window.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
