/**
 * "Do I already have these bytes?", asked once for a whole sync pass.
 *
 * Both audio downloaders open a sync pass by working out which of the remote's
 * references this device already holds, and both asked per reference with
 * `getAudioFileByHash` — one IndexedDB transaction each. A shared board of a
 * few hundred sounds is therefore a few hundred transactions before a single
 * byte is fetched, on every pass, including the overwhelmingly common one that
 * finds nothing to do. A sync makes up to six such passes.
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

import { getDb } from "@/lib/db";

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
