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

import {
  clearAudioCacheEntries,
  collectReferencedAudioFileIds,
  ensureAudioFileHash,
  getDb,
} from "./db";
import type { AudioFile, PadConfiguration } from "./db";
import { remapAudioFileIdKeys } from "./importExport";
import {
  dropCachedLoudness,
  getCachedLoudness,
  setCachedLoudness,
} from "./audio/loudness/cache";
import type { LoudnessAnalysis } from "./audio/loudness/types";

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

/**
 * A pad as the collapse has to treat it: the array plus the pre-V3 scalar.
 *
 * `PadConfiguration` stopped declaring `audioFileId` at V3, but rows still
 * carry it — `migrateStoreV4` catches a per-record update error and carries
 * on, so a record whose rewrite failed keeps the old shape forever. It is a
 * live reference (`collectReferencedAudioFileIds` counts it), so it has to be
 * a live remap target too.
 */
type CollapsiblePad = PadConfiguration & { audioFileId?: number };

/** What a group turned into, once the transaction had the real rows. */
interface Survivor {
  canonicalId: number;
  duplicateIds: number[];
  loudness?: LoudnessAnalysis;
}

/**
 * Folds everything the duplicates carry that the survivor does not into it.
 *
 * The election ranks rows on their loudness analysis and their id, so
 * everything else a row carries is lost the moment it is deleted — and two of
 * those are not recoverable. `driveFileIds` is keyed by profileId, so two rows
 * holding identical bytes can each hold the only route back to Drive for a
 * *different* profile; `serverHosted` records that this deployment's bucket
 * already holds the bytes, and losing it re-uploads them and charges the
 * hosted quota a second time.
 *
 * Everything merged here is a fact about the *bytes*, and the group is defined
 * by its bytes, so nothing can be contradicted by inheriting it. The survivor
 * still wins any key both hold: its entry is the one already in use.
 *
 * @returns The merged record, or null when the survivor already had it all
 */
function mergeAudioMetadata(
  canonical: AudioFile,
  duplicates: AudioFile[],
): AudioFile | null {
  const merged: AudioFile = { ...canonical };
  let changed = false;

  for (const duplicate of duplicates) {
    for (const [profileId, driveFileId] of Object.entries(
      duplicate.driveFileIds ?? {},
    )) {
      const key = Number(profileId);
      if (merged.driveFileIds?.[key] !== undefined) continue;
      merged.driveFileIds = { ...merged.driveFileIds, [key]: driveFileId };
      changed = true;
    }
    if (duplicate.serverHosted && !merged.serverHosted) {
      merged.serverHosted = true;
      changed = true;
    }
    if (!merged.loudness && duplicate.loudness) {
      merged.loudness = duplicate.loudness;
      changed = true;
    }
    if (!merged.hash && duplicate.hash) {
      merged.hash = duplicate.hash;
      changed = true;
    }
  }

  return changed ? merged : null;
}

/**
 * Points every pad at each group's survivor, then deletes the rows it replaced.
 *
 * **This deletes audio the user did not pick one by one.** Run it only behind
 * the preview and the confirmation, never on one click.
 *
 * One transaction over both stores, so no pad can start to name a row between
 * the decision and the delete. Four things happen inside it, in this order,
 * and the order is the safety story:
 *
 * 1. Every `canonicalId` is re-read. `groups` was produced before a dialog the
 *    user may have sat on, and a survivor that has since been deleted — a pad
 *    cleared, then the orphan sweep pressed — would otherwise have every pad
 *    in its group pointed at a row that does not exist. Such a group is
 *    skipped whole. A *new* matching row appearing in the same gap needs no
 *    handling: it is simply not collapsed this time.
 * 2. What the doomed rows carry is merged onto the survivor — see
 *    `mergeAudioMetadata`.
 * 3. Every pad in every profile is rewritten. Audio rows carry no profileId,
 *    so a group routinely spans profiles and a pass over one profile's pads
 *    would delete a row another profile still names. Both settings maps go
 *    through `remapAudioFileIdKeys` in "keep" mode: an id in no group is not a
 *    duplicate, so its setting stays under its own key, where "drop" would
 *    delete every setting on every pad this touched.
 * 4. Only rows that nothing names any more are deleted, asked through the same
 *    `collectReferencedAudioFileIds` the orphan sweep uses. After step 3 that
 *    is every duplicate, so the check is unreachable — which is the point. It
 *    costs one pass and it turns a future reference field nobody remapped from
 *    "the user's audio is gone" into "a row was not reclaimed".
 *
 * The sync stamps are deliberately *not* touched. A pad travels by content
 * hash and every row in a group shares one, so the blob this device publishes
 * is unchanged by the collapse; `updatedAt` still moves, because the record
 * really did change and `hasProfileChangedSince` reads it.
 *
 * @param groups The output of `findDuplicateAudioGroups`, after the user
 *   confirmed the preview
 * @returns How many rows went, and how many bytes came back
 */
export async function collapseDuplicateAudioGroups(
  groups: DuplicateAudioGroup[],
): Promise<{ removedFiles: number; reclaimedBytes: number }> {
  const nothing = { removedFiles: 0, reclaimedBytes: 0 };
  if (groups.length === 0) return nothing;

  const db = await getDb();
  const tx = db.transaction(["audioFiles", "padConfigurations"], "readwrite");
  const audioStore = tx.objectStore("audioFiles");
  const padStore = tx.objectStore("padConfigurations");

  // --- 1 and 2: settle the groups against the rows that are really there ---
  const idMap = new Map<number, number>();
  const canonicalIds = new Set<number>();
  const survivors: Survivor[] = [];

  for (const group of groups) {
    const canonical = await audioStore.get(group.canonicalId);
    if (!canonical) continue;

    const duplicates: AudioFile[] = [];
    const duplicateIds: number[] = [];
    for (const duplicateId of group.duplicateIds) {
      // A group naming its own survivor among the doomed is malformed, but
      // acting on it would delete the row every pad is about to be pointed at.
      if (duplicateId === group.canonicalId) continue;
      const duplicate = await audioStore.get(duplicateId);
      if (!duplicate) continue;
      duplicates.push(duplicate);
      duplicateIds.push(duplicateId);
      idMap.set(duplicateId, group.canonicalId);
    }

    canonicalIds.add(group.canonicalId);
    const merged = mergeAudioMetadata(canonical, duplicates);
    if (merged) await audioStore.put(merged);
    survivors.push({
      canonicalId: group.canonicalId,
      duplicateIds,
      loudness: (merged ?? canonical).loudness,
    });
  }

  if (idMap.size === 0) {
    await tx.done;
    return nothing;
  }

  // --- 3: rewrite every pad, in every profile ---
  /**
   * Re-keys one settings map, then restores the survivor's own entry.
   *
   * A pad that named a row and its duplicate had two settings for what is now
   * one sound, and only one can survive — the maps are keyed by audio file id
   * and there is one id left. Nothing can reconcile that, so the only question
   * is whether the outcome is decided or accidental: the survivor's own entry
   * is the one that was already attached to the row that stays.
   */
  const remapSettings = <T>(
    settings: Record<number, T> | undefined,
  ): Record<number, T> | undefined => {
    const remapped = remapAudioFileIdKeys(settings, idMap, "keep");
    if (!settings || !remapped) return remapped;
    for (const canonicalId of canonicalIds) {
      const own = settings[canonicalId];
      if (own !== undefined) remapped[canonicalId] = own;
    }
    return remapped;
  };

  const finalPads: CollapsiblePad[] = [];
  const now = new Date();
  let cursor = await padStore.openCursor();
  while (cursor) {
    const pad = cursor.value as CollapsiblePad;
    const ids = pad.audioFileIds ?? [];
    const legacyId = pad.audioFileId;
    const remapsLegacy = typeof legacyId === "number" && idMap.has(legacyId);

    if (ids.some((id) => idMap.has(id)) || remapsLegacy) {
      const rewritten: CollapsiblePad = {
        ...pad,
        // Only when the pad had one: a pre-V3 row names its sound through the
        // scalar, and inventing an array on it is a migration, not a remap.
        ...(pad.audioFileIds
          ? // A pad that named both rows would otherwise list one sound twice.
            { audioFileIds: [...new Set(ids.map((id) => idMap.get(id) ?? id))] }
          : {}),
        ...(remapsLegacy ? { audioFileId: idMap.get(legacyId)! } : {}),
        audioTrimSettings: remapSettings(pad.audioTrimSettings),
        audioGainSettings: remapSettings(pad.audioGainSettings),
        updatedAt: now,
      };
      await cursor.update(rewritten);
      finalPads.push(rewritten);
    } else {
      finalPads.push(pad);
    }
    cursor = await cursor.continue();
  }

  // --- 4: delete only what nothing names ---
  const stillReferenced = collectReferencedAudioFileIds(finalPads);
  const deletedIds: number[] = [];
  let reclaimedBytes = 0;

  for (const duplicateId of idMap.keys()) {
    if (canonicalIds.has(duplicateId)) continue;
    if (stillReferenced.has(duplicateId)) continue;
    const record = await audioStore.get(duplicateId);
    if (!record) continue;
    reclaimedBytes += record.blob.size;
    await audioStore.delete(duplicateId);
    deletedIds.push(duplicateId);
  }
  await tx.done;

  // Two in-memory maps outlive the rows. The decoded-buffer cache only has to
  // forget the deleted ids — a survivor that is not cached is decoded again,
  // and a miss is never the wrong sound.
  await clearAudioCacheEntries(deletedIds);

  // The loudness cache is different, and this is the half that is easy to
  // miss: it is read *synchronously* at trigger time and only refilled at
  // profile activation, so a pad repointed at a survivor that is not in it
  // resolves gain from nothing and normalisation silently reverts to 0 dB for
  // the rest of the session. An analysis measures the bytes and the group is
  // defined by its bytes, so whatever the group already had resident is a
  // correct answer for the survivor; the stored analysis is the fallback.
  // Inherit before dropping, not after: the entry being read is the one about
  // to be deleted.
  for (const survivor of survivors) {
    if (getCachedLoudness(survivor.canonicalId)) continue;
    const inherited = survivor.duplicateIds
      .map(getCachedLoudness)
      .find((analysis) => analysis !== undefined);
    const analysis = inherited ?? survivor.loudness;
    if (analysis) setCachedLoudness(survivor.canonicalId, analysis);
  }
  dropCachedLoudness(deletedIds);

  return { removedFiles: deletedIds.length, reclaimedBytes };
}
