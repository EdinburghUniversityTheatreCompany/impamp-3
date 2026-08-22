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
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. Its rejection is logged after this file has
// finished, and that log is what tears the worker down mid-run under
// coverage. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

const { createHashlessAudioIndex, addAudioFile, computeBlobHash, getDb } =
  await import("@/lib/db");

/** Adds a sound and puts `hash` back to whatever a stored row would hold. */
async function addAudioWithStoredHash(
  name: string,
  bytes: string,
  hash: string | undefined,
): Promise<number> {
  const id = await addAudioFile({
    blob: new Blob([bytes]),
    name,
    type: "audio/mpeg",
  });
  const db = await getDb();
  const row = await db.get("audioFiles", id);
  await db.put("audioFiles", { ...row!, hash });
  return id;
}

/** Adds a sound and strips its stored hash, as a pre-hashing record would be. */
async function addHashlessAudio(name: string, bytes: string): Promise<number> {
  return addAudioWithStoredHash(name, bytes, undefined);
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

  it("adds nothing when every row already carries its stored hash", async () => {
    // The expensive half of this index is reading every blob in the library,
    // and every caller reaches it only after `createStoredHashIndex` missed.
    // If nothing predates hashing, that miss already means no local row holds
    // these bytes — so there is nothing this index could add, and the library
    // must not be read to find that out.
    await addAudioFile({
      blob: new Blob(["horn-bytes"]),
      name: "horn.mp3",
      type: "audio/mpeg",
    });

    expect(await createHashlessAudioIndex()()).toEqual(new Map());
  });

  it("still scans once a single row predates hashing", async () => {
    // The counts above decide for the whole library, so one unhashed row has
    // to be enough to bring the scan back — including for the rows that do
    // carry a hash, since the map is what the caller looks in.
    const hashedId = await addAudioFile({
      blob: new Blob(["stab-bytes"]),
      name: "stab.mp3",
      type: "audio/mpeg",
    });
    const hashlessId = await addHashlessAudio("horn.mp3", "horn-bytes");

    const index = await createHashlessAudioIndex()();

    expect(index.get(await computeBlobHash(new Blob(["horn-bytes"])))).toBe(
      hashlessId,
    );
    expect(index.get(await computeBlobHash(new Blob(["stab-bytes"])))).toBe(
      hashedId,
    );
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

/**
 * A stored hash of `""`, and what the count comparison makes of it.
 *
 * 🟢 12 of the 2026-08-22 subsystem review, marked "claim to check": the scan
 * is decided by `db.count("audioFiles")` against
 * `db.countFromIndex("audioFiles", "hash")`, on the reasoning that IndexedDB
 * leaves a record out of an index when its key is `undefined`. `""` is a valid
 * key, so a row holding one counts as hashed.
 *
 * Measured rather than argued, because the two halves of the answer point
 * different ways and the second one contradicts the finding.
 *
 * Nothing in production writes such a row. `addOrReuseAudioFile` and
 * `importAudioSources` both normalise with `||` — each pinned by its own test
 * in `db.audioDedup.test.ts` and `importExport.dedup.test.ts` — and every other
 * writer is a `put` of a row it just read, which carries whatever hash was
 * already there. So these cases characterise a shape the library should never
 * be in; see the note in `audioHashIndex.ts` for why one could once have
 * arrived, and why it self-heals if it did.
 */
describe("a row stored with an empty hash", () => {
  it("counts as hashed, so a library of nothing else is not scanned", async () => {
    // rows 2, indexed 2 — the counts agree and the scan is skipped, so these
    // rows keep their empty hash and no local row can be matched by content.
    await addAudioWithStoredHash("horn.mp3", "horn-bytes", "");
    await addAudioWithStoredHash("stab.mp3", "stab-bytes", "");
    const db = await getDb();

    expect(await db.count("audioFiles")).toBe(2);
    expect(await db.countFromIndex("audioFiles", "hash")).toBe(2);
    expect(await createHashlessAudioIndex()()).toEqual(new Map());
    expect((await db.getAll("audioFiles")).map((row) => row.hash)).toEqual([
      "",
      "",
    ]);
  });

  it("cannot hide a genuinely unhashed row from the scan", async () => {
    // The half the review got the wrong way round. An empty hash adds one to
    // both counts, so it is neutral; a row with no hash at all adds one to the
    // left only, and on its own keeps `rows > hashed` true. The scan therefore
    // still runs — and `ensureAudioFileHash` tests the stored hash for truth,
    // so it repairs the empty one on the way past.
    await addAudioWithStoredHash("horn.mp3", "horn-bytes", "");
    await addHashlessAudio("stab.mp3", "stab-bytes");
    const db = await getDb();

    expect(await db.count("audioFiles")).toBe(2);
    expect(await db.countFromIndex("audioFiles", "hash")).toBe(1);

    const index = await createHashlessAudioIndex()();

    expect(index.get(await computeBlobHash(new Blob(["horn-bytes"])))).toBe(
      (await db.getAllKeys("audioFiles"))[0],
    );
    expect(index.get(await computeBlobHash(new Blob(["stab-bytes"])))).toBe(
      (await db.getAllKeys("audioFiles"))[1],
    );
    expect((await db.getAll("audioFiles")).every((row) => row.hash)).toBe(true);
  });
});
