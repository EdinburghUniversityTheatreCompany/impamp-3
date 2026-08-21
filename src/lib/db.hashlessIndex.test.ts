/**
 * `createHashlessAudioIndex` — the index the sync paths reach for when a
 * reference arrives without a usable hash.
 *
 * This lived as two hand-written copies, in the Drive downloader and the
 * hosted-audio downloader, differing only in a temporary variable — near
 * enough to drift, far enough apart that the duplication gate never saw them.
 *
 * Two properties are worth pinning, because both are why it is shaped the way
 * it is. It must be lazy, since building it reads and SHA-256s every audio
 * blob in the library and most syncs never need it. And it must be a factory
 * rather than a module-level cache, because an index outliving its sync pass
 * would miss files added since and re-download audio the device already holds.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { createHashlessAudioIndex, addAudioFile, computeBlobHash, getDb } =
  await import("@/lib/db");

/** Adds a sound and strips its stored hash, as a pre-hashing record would be. */
async function addHashlessAudio(name: string, bytes: string): Promise<number> {
  const id = await addAudioFile({
    blob: new Blob([bytes]),
    name,
    type: "audio/mpeg",
  });
  const db = await getDb();
  const row = await db.get("audioFiles", id);
  await db.put("audioFiles", { ...row!, hash: undefined });
  return id;
}

beforeEach(async () => {
  await clearAllStores();
});

describe("createHashlessAudioIndex", () => {
  it("maps a pre-hashing file to its id by the hash of its bytes", async () => {
    const id = await addHashlessAudio("horn.mp3", "horn-bytes");

    const index = await createHashlessAudioIndex()();

    expect(index.get(await computeBlobHash(new Blob(["horn-bytes"])))).toBe(id);
  });

  it("builds nothing until it is asked", async () => {
    await addHashlessAudio("horn.mp3", "horn-bytes");
    const db = await getDb();

    // Merely creating it must not touch the library — the expensive part is
    // reading and hashing every blob, and most syncs never need it at all.
    createHashlessAudioIndex();

    const stillHashless = await db.get(
      "audioFiles",
      (await db.getAllKeys("audioFiles"))[0],
    );
    expect(stillHashless?.hash).toBeUndefined();
  });

  it("reuses the index it already built rather than rescanning", async () => {
    await addHashlessAudio("horn.mp3", "horn-bytes");
    const get = createHashlessAudioIndex();

    const first = await get();
    const second = await get();

    expect(second).toBe(first);
  });

  it("gives a later pass its own index, so new audio is not missed", async () => {
    const firstPass = createHashlessAudioIndex();
    await firstPass();

    await addHashlessAudio("stab.mp3", "stab-bytes");
    const secondPass = await createHashlessAudioIndex()();

    // A module-level cache would still be answering for the older library.
    expect(
      secondPass.get(await computeBlobHash(new Blob(["stab-bytes"]))),
    ).toBeDefined();
  });
});
