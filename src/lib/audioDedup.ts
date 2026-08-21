/**
 * The duplicate audio rows a library has already accumulated.
 *
 * `addOrReuseAudioFile` stops new duplicates. This finds the ones that arrived
 * before it — every sound a user imported twice — so they can be shown and
 * then collapsed onto a single row.
 *
 * The module sits above `db.ts` rather than inside it, because the collapse
 * re-keys `audioTrimSettings` and `audioGainSettings` through
 * `remapAudioFileIdKeys`, and that helper lives in `importExport.ts`, which
 * imports `db.ts`. One rule, one place, and no import cycle.
 */

import { ensureAudioFileHash, getDb } from "./db";

export interface DuplicateAudioGroup {
  /** The content hash every row in the group shares. */
  hash: string;
  /** The row that survives the collapse. */
  canonicalId: number;
  /** The rows the collapse deletes. */
  duplicateIds: number[];
  /** Bytes the collapse gives back. */
  reclaimableBytes: number;
}

/** One audio row, reduced to what the grouping and the election need. */
interface CandidateRow {
  id: number;
  size: number;
  analysed: boolean;
}

/** Files the row under its hash, starting the group if it is the first. */
function fileUnderHash(
  byHash: Map<string, CandidateRow[]>,
  hash: string,
  row: CandidateRow,
): void {
  const rows = byHash.get(hash);
  if (rows) {
    rows.push(row);
  } else {
    byHash.set(hash, [row]);
  }
}

/**
 * Groups the audio rows that hold identical bytes.
 *
 * Reads only, with one exception that is the point of the whole pass: a row
 * with no hash gets one written. Rows predating the `hash` field, and rows
 * written by a path that passed a hash straight through without one, are
 * invisible to the `hash` index — IndexedDB omits a record whose key path is
 * undefined — so a grouping built on an index scan would report a clean
 * database on exactly the libraries with the most duplication in them.
 *
 * Identity is the SHA-256 of the bytes and nothing else, matching
 * `addOrReuseAudioFile`: the same sound under two names is one group.
 *
 * @returns One entry per set of identical bytes held by more than one row,
 *   in the order the store's first member of each was reached
 */
export async function findDuplicateAudioGroups(): Promise<
  DuplicateAudioGroup[]
> {
  const db = await getDb();

  const byHash = new Map<string, CandidateRow[]>();
  const hashless: CandidateRow[] = [];

  let cursor = await db.transaction("audioFiles").store.openCursor();
  while (cursor) {
    const record = cursor.value;
    if (record.id !== undefined) {
      // `blob.size` is metadata on the Blob handle, so the bytes stay on disk.
      const row: CandidateRow = {
        id: record.id,
        size: record.blob.size,
        analysed: record.loudness !== undefined,
      };
      // Truthiness, not a null check: `""` is a valid IndexedDB key and a
      // valid Map key, and a hash reaching the store from unvalidated JSON
      // can be one. Taken at face value it groups every such row together and
      // reports unrelated sounds as copies of each other, which the collapse
      // would then act on. A missing hash means "no match", never "matches
      // everything" — the same rule `findAudioFileIdByHashIn` enforces.
      if (record.hash) {
        fileUnderHash(byHash, record.hash, row);
      } else {
        hashless.push(row);
      }
    }
    cursor = await cursor.continue();
  }

  // The hashing runs second, outside the transaction: `ensureAudioFileHash`
  // reads a blob and calls `crypto.subtle`, and an await on either closes an
  // IndexedDB transaction under it. Only the rows that lack a hash are read
  // again — hashing every row up front would read the whole store twice, and
  // every audioFiles record carries a Blob.
  for (const row of hashless) {
    const hash = await ensureAudioFileHash(row.id);
    if (!hash) continue;
    fileUnderHash(byHash, hash, row);
  }

  const groups: DuplicateAudioGroup[] = [];
  for (const [hash, rows] of byHash) {
    if (rows.length < 2) continue;
    // A row with an analysis wins, then the lowest id. The analysis is the
    // expensive thing to lose; the id keeps the choice stable between runs
    // and independent of the order the rows were assembled in, which the
    // hashing pass above makes differ from id order.
    const ranked = [...rows].sort(
      (a, b) => Number(b.analysed) - Number(a.analysed) || a.id - b.id,
    );
    const [canonical, ...duplicates] = ranked;
    groups.push({
      hash,
      canonicalId: canonical.id,
      duplicateIds: duplicates.map((row) => row.id),
      reclaimableBytes: duplicates.reduce((sum, row) => sum + row.size, 0),
    });
  }

  return groups;
}
