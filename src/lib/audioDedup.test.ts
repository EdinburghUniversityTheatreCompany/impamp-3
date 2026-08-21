/**
 * Finding the duplicate audio rows a library has already accumulated.
 *
 * Audio rows are global, and until reuse landed every import wrote a fresh
 * blob for a sound the library already held. This half only *reports* the
 * groups; the collapse that acts on them is separate, so the report can be
 * shown to a user before anything is deleted.
 *
 * The hard cases are not the obvious pair. They are the rows written before
 * the `hash` field existed — invisible to the `hash` index, and a large part
 * of why this exists — and the rows carrying an empty hash, which is a valid
 * IndexedDB key and so would group every unrelated sound into one "duplicate".
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The loudness pipeline, stubbed.
 *
 * `db.ts` imports it dynamically at call time, so `vi.doMock` registered here
 * — before `db.ts` itself is imported — is what the dynamic import resolves
 * to. Without it every `addAudioFile` fires a real background analysis that
 * reaches Web Audio, which node does not have, and the election tests below
 * turn on whether a row carries an analysis: a stray write racing the
 * assertions is exactly the flake that would be blamed on the fixture.
 */
const analyseAndStore = vi.fn(async () => null);
vi.doMock("@/lib/audio/loudness/pipeline", () => ({ analyseAndStore }));

const { findDuplicateAudioGroups } = await import("./audioDedup");
const { addAudioFile, computeBlobHash, getDb } = await import("./db");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** Bytes that are not the horn's, so grouping the two would be visible. */
function stab(): Blob {
  return new Blob(["a completely different stab"], { type: "audio/wav" });
}

/** A loudness analysis, in the smallest shape the type accepts. */
function someAnalysis() {
  return {
    algoVersion: 1,
    sampleRate: 48000,
    duration: 1,
    blockMeanSquare: new Float32Array([0.5]),
    hopTruePeak: new Float32Array([0.5]),
  };
}

/**
 * Writes a row straight to the store, bypassing `addAudioFile`.
 *
 * `addAudioFile` always computes and stores a hash, so it cannot produce the
 * rows this module exists to find. Going round it is the only way to build a
 * pre-v5 row, or one whose hash arrived empty from unvalidated JSON.
 */
async function putRawRow(row: {
  name: string;
  blob: Blob;
  hash?: string;
}): Promise<number> {
  const db = await getDb();
  return db.add("audioFiles", {
    name: row.name,
    type: "audio/wav",
    blob: row.blob,
    ...(row.hash === undefined ? {} : { hash: row.hash }),
    createdAt: new Date(0),
  });
}

/** Two rows holding the same bytes. `addAudioFile` never reuses, by design. */
async function twoCopiesOfTheHorn(): Promise<[number, number]> {
  const first = await addAudioFile({
    name: "horn.wav",
    type: "audio/wav",
    blob: horn(),
  });
  const second = await addAudioFile({
    name: "horn (1).wav",
    type: "audio/wav",
    blob: horn(),
  });
  expect(second).not.toBe(first);
  return [first, second];
}

beforeEach(async () => {
  await clearAllStores();
  analyseAndStore.mockClear();
});

describe("findDuplicateAudioGroups", () => {
  it("reports nothing when every row is unique", async () => {
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
    await addAudioFile({ name: "stab.wav", type: "audio/wav", blob: stab() });

    expect(await findDuplicateAudioGroups()).toEqual([]);
  });

  it("groups rows that hold the same bytes and elects the lowest id", async () => {
    const [first, second] = await twoCopiesOfTheHorn();

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].hash).toBe(await computeBlobHash(horn()));
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second]);
    expect(groups[0].reclaimableBytes).toBe(horn().size);
  });

  it("prefers a row that already carries a loudness analysis", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    const db = await getDb();
    const analysed = (await db.get("audioFiles", second))!;
    await db.put("audioFiles", { ...analysed, loudness: someAnalysis() });

    const groups = await findDuplicateAudioGroups();

    // The analysis is the expensive part, so the row that has one wins even
    // though its id is higher.
    expect(groups[0].canonicalId).toBe(second);
    expect(groups[0].duplicateIds).toEqual([first]);
  });

  it("hashes a row that has none before it groups", async () => {
    // Rows written before the hash field existed carry none, and IndexedDB
    // omits a record whose key path is undefined — so an index scan sees no
    // rows at all and would report a clean database on the very libraries
    // that need the cleanup most.
    const first = await putRawRow({ name: "horn.wav", blob: horn() });
    const second = await putRawRow({ name: "horn (1).wav", blob: horn() });

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second]);

    // The hash is written back, not just used in passing: the collapse and
    // every later reuse read it from the row.
    const db = await getDb();
    const hornHash = await computeBlobHash(horn());
    expect((await db.get("audioFiles", first))?.hash).toBe(hornHash);
    expect((await db.get("audioFiles", second))?.hash).toBe(hornHash);
  });

  it("elects the lowest id when the hashed copy was scanned first", async () => {
    // The mixed library is the realistic one: an old row with no hash beside
    // a newer row that has one. The scan can only reach the hashless row
    // after it has read a blob and hashed it, so the group is assembled out
    // of id order and the election cannot lean on the order rows arrived in.
    const hashless = await putRawRow({ name: "horn.wav", blob: horn() });
    const hashed = await putRawRow({
      name: "horn (1).wav",
      blob: horn(),
      hash: await computeBlobHash(horn()),
    });
    expect(hashless).toBeLessThan(hashed);

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(hashless);
    expect(groups[0].duplicateIds).toEqual([hashed]);
  });

  it("does not group two different sounds that both carry an empty hash", async () => {
    // `""` is a valid IndexedDB key and a valid Map key, so an empty hash
    // taken at face value collapses every unhashed sound into one group —
    // and the collapse acting on that would delete unrelated audio. A missing
    // hash must mean "no match", never "matches everything".
    const hornId = await putRawRow({
      name: "horn.wav",
      blob: horn(),
      hash: "",
    });
    const stabId = await putRawRow({
      name: "stab.wav",
      blob: stab(),
      hash: "",
    });

    expect(await findDuplicateAudioGroups()).toEqual([]);

    const db = await getDb();
    expect((await db.get("audioFiles", hornId))?.hash).toBe(
      await computeBlobHash(horn()),
    );
    expect((await db.get("audioFiles", stabId))?.hash).toBe(
      await computeBlobHash(stab()),
    );
  });

  it("lists every duplicate in a group of three and sums their bytes", async () => {
    const [first, second] = await twoCopiesOfTheHorn();
    const third = await addAudioFile({
      name: "horn (2).wav",
      type: "audio/wav",
      blob: horn(),
    });

    const groups = await findDuplicateAudioGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalId).toBe(first);
    expect(groups[0].duplicateIds).toEqual([second, third]);
    expect(groups[0].reclaimableBytes).toBe(horn().size * 2);
  });

  it("reports each set of identical bytes as its own group", async () => {
    const [firstHorn, secondHorn] = await twoCopiesOfTheHorn();
    const firstStab = await addAudioFile({
      name: "stab.wav",
      type: "audio/wav",
      blob: stab(),
    });
    const secondStab = await addAudioFile({
      name: "stab (1).wav",
      type: "audio/wav",
      blob: stab(),
    });
    const unique = await addAudioFile({
      name: "riser.wav",
      type: "audio/wav",
      blob: new Blob(["a long slow riser"], { type: "audio/wav" }),
    });

    const groups = await findDuplicateAudioGroups();

    expect(
      groups.map((group) => [group.canonicalId, group.duplicateIds]),
    ).toEqual([
      [firstHorn, [secondHorn]],
      [firstStab, [secondStab]],
    ]);
    expect(groups.flatMap((group) => group.duplicateIds)).not.toContain(unique);
  });
});
