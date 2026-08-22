/**
 * "Do I already have these bytes?", asked once for a whole sync pass.
 *
 * Both audio downloaders open a sync pass by working out which of the remote's
 * references this device already holds, and both used to ask that once per
 * reference, through a helper that opened its own read transaction on the
 * `hash` index. A shared board of a few hundred sounds is therefore a few
 * hundred transactions before a single byte is fetched, on every pass,
 * including the overwhelmingly common one that finds nothing to do. A sync
 * makes up to six such passes.
 *
 * The question does not change during a pass, so neither should the answer:
 * one cursor over `audioFiles` builds the whole map.
 *
 * Two things it deliberately is not:
 *
 * - It is not `createHashlessAudioIndex`. That one exists for records written
 *   before hashing, reads and SHA-256s every blob in the library, and is the
 *   expensive fallback reached only when this one misses. This is a cheap
 *   projection of what the store already knows.
 * - It is not a module-level cache. A pass wants the library as it is *now*;
 *   an index outliving its pass would miss files added since and re-download
 *   audio the device already has. Same reasoning, same shape, as its sibling.
 *
 * The cursor reads three fields per record and never touches `blob`. That is
 * not tidiness: every `audioFiles` record carries a Blob, so materialising the
 * records would pull the entire audio library into memory at once.
 */

import { getAudioFile, getDb } from "@/lib/db";

/** As much of a local audio file as deciding "already have it" needs. */
export interface LocalAudioRef {
  id: number;
  /** Which profiles have published these bytes to Drive, and as what. */
  driveFileIds?: Record<number, string>;
}

export interface StoredHashIndex {
  /** The local file with these exact bytes, if this device has one. */
  lookup: (hash: string) => Promise<LocalAudioRef | undefined>;
  /**
   * Record a file the pass has just stored, so a blob that names the same
   * bytes twice does not fetch them twice.
   */
  remember: (hash: string, ref: LocalAudioRef) => Promise<void>;
}

/**
 * A lazy index of local audio by its stored content hash.
 *
 * Lazy because a pass with no references at all should cost nothing, and a
 * factory because the index must not outlive the pass.
 */
export function createStoredHashIndex(): StoredHashIndex {
  let building: Promise<Map<string, LocalAudioRef>> | null = null;

  const build = async (): Promise<Map<string, LocalAudioRef>> => {
    const index = new Map<string, LocalAudioRef>();
    const db = await getDb();
    let cursor = await db.transaction("audioFiles").store.openCursor();

    while (cursor) {
      const { id, hash, driveFileIds } = cursor.value;
      // First wins, matching what the `hash` index answers when two records
      // hold the same bytes: both are ordered by primary key, so both name the
      // older record.
      if (hash && id !== undefined && !index.has(hash)) {
        index.set(hash, { id, driveFileIds });
      }
      cursor = await cursor.continue();
    }

    return index;
  };

  const get = () => (building ??= build());

  return {
    async lookup(hash) {
      return (await get()).get(hash);
    },
    async remember(hash, ref) {
      (await get()).set(hash, ref);
    },
  };
}

/**
 * The local row holding these exact bytes, hashing the pre-hashing rows if it
 * comes to that.
 *
 * The one question every inbound sync path asks, and the one answer they must
 * all give. Identity is the SHA-256 of the bytes and nothing else — the same
 * rule `addOrReuseAudioFile` and `importAudioSources` keep. A file *name* looks
 * like an identity and is not: `horn.wav` from one library and `horn.wav` from
 * another are two recordings, and merging them onto one row makes every pad on
 * both sides play whichever arrived first, with nothing left to compare against
 * afterwards. So a reference with no hash matches nothing. A missing hash must
 * mean "no match", never "any match".
 *
 * The second lookup is what keeps that affordable for a library written before
 * hashing: those rows are hashed once, from their own bytes, rather than
 * matched on their names. `createHashlessAudioIndex` costs nothing when there
 * are none.
 *
 * **An empty stored hash cannot switch that second lookup off.** Asked and
 * answered so nobody derives it again — it was 🟢 12 of the 2026-08-22
 * subsystem review, raised as a claim its author could not settle from the
 * source. `createHashlessAudioIndex` decides whether to scan by comparing
 * `db.count("audioFiles")` with `db.countFromIndex("audioFiles", "hash")`, and
 * `""` is a valid IndexedDB key, so a row holding one does count as hashed.
 * Two things follow, and the second is the one the finding had backwards
 * (both measured, in `db.hashlessIndex.test.ts`):
 *
 * - A library whose *only* unhashed rows carry `""` is skipped, and those rows
 *   keep their empty hash. Nothing can then be matched by content, so the
 *   bytes are downloaded again.
 * - A row with no hash at all is **not** hidden by them. An empty hash adds
 *   one to each count and is therefore neutral; a missing one adds to the left
 *   alone and keeps `rows > hashed` true by itself. The scan runs, and
 *   `ensureAudioFileHash` tests the stored hash for truth, so it repairs the
 *   empty rows on the way past.
 *
 * And no production writer makes one. Both writers of new rows normalise with
 * `||` — `addOrReuseAudioFile` and `importAudioSources`, each with a test
 * naming this exact case — and every other writer `put`s a row it just read,
 * carrying whatever hash was there. `addAudioFile` is the one place still
 * using `??`, and it has no production callers left; it survives for the dedup
 * tests, which need a writer that can still make a duplicate. Before 2ab873a
 * the Drive downloader passed a remote `ref.hash` straight into it, so a
 * foreign or corrupt sync blob could have written such a row into a database
 * that still exists — but this app never publishes an empty hash (a ref takes
 * its hash from the stored one or from `ensureAudioFileHash`, both computed),
 * the cost is a re-download rather than a wrong sound, and the second point
 * above means it heals the moment any row lacks a hash entirely.
 *
 * @param hash - The content hash the remote reference carries, if any
 * @param stored - This pass's index of what the store already has hashes for
 * @param getHashlessIndex - This pass's lazy index of what it does not
 * @returns The local row holding these bytes, or undefined
 */
export async function lookupLocalAudioByHash(
  hash: string | undefined,
  stored: StoredHashIndex,
  getHashlessIndex: () => Promise<Map<string, number>>,
): Promise<LocalAudioRef | undefined> {
  if (!hash) return undefined;

  const byStoredHash = await stored.lookup(hash);
  if (byStoredHash) return byStoredHash;

  const legacyId = (await getHashlessIndex()).get(hash);
  if (legacyId === undefined) return undefined;

  // The index knows only the id, and the caller needs to know whether this
  // profile has already published these bytes.
  const record = await getAudioFile(legacyId);
  if (record?.id === undefined) return undefined;

  const found = { id: record.id, driveFileIds: record.driveFileIds };
  // It carries a stored hash now — `ensureAudioFileHash` wrote one as the
  // index was built — so the cheap index can answer for it from here on.
  await stored.remember(hash, found);
  return found;
}
