/**
 * `downloadMissingAudioFiles` — what the store is allowed to believe.
 *
 * The sync blob names every sound by content hash, and the download path
 * passed that hash straight to `addAudioFile`. `addAudioFile` computes a hash
 * only when none is supplied (`audioFile.hash ?? computeBlobHash(...)`), so
 * supplying one short-circuits the check: whatever bytes arrived were stored
 * under whatever name the *sender* chose.
 *
 * That is the one thing a content-addressed store must never do. Once bytes
 * live under a hash they do not have, every later lookup for that hash returns
 * the wrong sound, deduplication silently adopts it, and nothing downstream
 * has any way to notice — the hash *is* the identity.
 *
 * The server-side twin of this was closed as SV1, and deliberately hashes what
 * the bucket actually holds rather than what the client claimed. This is the
 * same rule on the client.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadAudioFileAsBlob = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, downloadAudioFileAsBlob };
});

const { downloadMissingAudioFiles } = await import("./sync");
const { getDb, computeBlobHash } = await import("@/lib/db");

/** The bytes actually served by Drive for every test below. */
const realBytes = () => new Blob(["the-actual-audio-bytes"]);

const refFor = (hash: string) => [
  {
    id: 200,
    name: "horn.mp3",
    type: "audio/mpeg",
    driveFileId: "drive-horn",
    hash,
  },
];

beforeEach(async () => {
  await clearAllStores();
  downloadAudioFileAsBlob.mockReset();
  downloadAudioFileAsBlob.mockResolvedValue(realBytes());
});

/** Every audio row currently in the store. */
async function storedAudio() {
  const db = await getDb();
  return db.getAll("audioFiles");
}

describe("a downloaded sound is stored under the hash of its own bytes", () => {
  it("keeps the claimed hash when the bytes really do hash to it", async () => {
    const trueHash = await computeBlobHash(realBytes());

    const { warnings } = await downloadMissingAudioFiles(
      refFor(trueHash) as never,
      1,
      { accessToken: "t", expiresAt: Date.now() + 3_600_000 } as never,
      () => {},
    );

    const rows = await storedAudio();
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(trueHash);
    expect(warnings).toEqual([]);
  });

  it("never stores bytes under a hash they do not have", async () => {
    // The whole finding: a sender that names the wrong hash used to have that
    // name written straight into the content-addressed store.
    const { warnings } = await downloadMissingAudioFiles(
      refFor(
        "0000000000000000000000000000000000000000000000000000000000000000",
      ) as never,
      1,
      { accessToken: "t", expiresAt: Date.now() + 3_600_000 } as never,
      () => {},
    );

    const rows = await storedAudio();
    const trueHash = await computeBlobHash(realBytes());
    for (const row of rows) {
      expect(row.hash).not.toBe(
        "0000000000000000000000000000000000000000000000000000000000000000",
      );
      if (row.hash) expect(row.hash).toBe(trueHash);
    }

    // And it must say so rather than failing silently.
    expect(warnings.join(" ")).toMatch(/horn\.mp3/);
  });
});
