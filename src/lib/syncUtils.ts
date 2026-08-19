import {
  Profile,
  PadConfiguration,
  PageMetadata,
  ensureAudioFileHash,
} from "./db"; // Import main data types
import { remapPadSettingsOnMerge } from "./importExport";
import { migratedBankId } from "./dbMigrations/v7BankId";
import type { WireProfile } from "./profileWire";

// Type guard to check if an object has sync fields
// Exporting Syncable type for use in other modules
export type Syncable = (Profile | PadConfiguration | PageMetadata) & {
  id?: number;
  _created?: number;
  _modified?: number;
  _fieldsModified?: Record<string, number>;
};

/**
 * Generates a consistent timestamp (milliseconds since epoch) for synchronization.
 */
export const generateTimestamp = (): number => {
  return Date.now();
};

/**
 * Deep clone an object using JSON stringify/parse.
 * Note: This will lose Date objects, functions, undefined values. Use cautiously.
 * Consider a library like lodash.cloneDeep for more robust cloning if needed.
 */
export const deepClone = <T>(obj: T): T => {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (e) {
    console.error("Deep clone failed:", e);
    // Fallback or re-throw depending on requirements
    throw new Error("Failed to deep clone object.");
  }
};

// --- Conflict Detection Logic ---

export interface FieldConflict {
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  localModTime: number;
  remoteModTime: number;
}

export interface ItemConflict {
  storeName: "profiles" | "padConfigurations" | "pageMetadata";
  key: string | number; // Unique key (profile ID, bankId-padIndex, bankId)
  id?: number; // Original DB ID if available
  type: "field_conflict" | "local_only" | "remote_only";
  localItem?: Syncable | null;
  remoteItem?: Syncable | null;
  fieldConflicts?: FieldConflict[]; // Only for type 'field_conflict'
}

// --- Helper: Compare Individual Syncable Items ---
interface CompareItemResult {
  isConflict: boolean;
  fieldConflicts: FieldConflict[];
  winner: "local" | "remote" | "none";
  mergedItem: Syncable | null;
}

/**
 * Pad fields that are a second view of another field, keyed by content hash.
 *
 * They are synthesised at export (`getLocalProfileSyncData`) and never written
 * through `upsertPadConfiguration`, so nothing stamps them into
 * `_fieldsModified`. Merged on their own they therefore fell through to the
 * whole-item `_modified` comparison while their originals were decided
 * per-field — and the two answers could come from different sides, leaving a
 * pad whose ids and hashes named different recordings. Because
 * `updateLocalData` prefers the hashes, the pad then played the wrong sound and
 * published it.
 *
 * So they do not get a say of their own: each travels with whichever side won
 * the field it derives from.
 */
const DERIVED_HASH_TWINS: Readonly<Record<string, string>> = {
  audioFileIds: "audioFileHashes",
  audioTrimSettings: "audioTrimSettingsByHash",
  audioGainSettings: "audioGainSettingsByHash",
};

const DERIVED_HASH_FIELDS = new Set(Object.values(DERIVED_HASH_TWINS));

/**
 * Records a merged field's modification stamp, or removes it when there is
 * nothing to record.
 *
 * An unstamped field must stay unstamped. Writing an explicit `0` reads as a
 * real answer everywhere downstream, and the merged record is written straight
 * back over the stored one — so a `0` computed from a snapshot taken before the
 * user's edit landed on top of the stamp that edit had just raised. The value
 * survived; the record that this device had changed it did not. The next merge
 * then found a field nobody here had touched and settled it silently, which is
 * a lost update with no conflict raised.
 *
 * @param stamps - The merged record's `_fieldsModified`, mutated in place
 * @param field - The field being merged
 * @param stamp - The stamp the merge settled on; 0 means "neither side ever
 *   stamped this"
 */
const stampMergedField = (
  stamps: Record<string, number>,
  field: string,
  stamp: number,
): void => {
  if (stamp > 0) stamps[field] = stamp;
  else delete stamps[field];
};

/** Fields that describe the record's identity rather than its content. */
const isContentField = (key: string): boolean =>
  !key.startsWith("_") &&
  key !== "id" &&
  key !== "profileId" &&
  key !== "createdAt" &&
  key !== "updatedAt";

/**
 * Reconciles a merged record with the record as it actually is on this device
 * now, rather than as it was when the merge read it.
 *
 * A sync is not instant. It reads the local data, spends a round trip or two on
 * the network — plus however long the audio downloads take — and only then
 * writes the merged result back. Anything the user edited in that window is
 * edited on a record the merge has never seen, and a plain `put` of the merged
 * record discards it: the pad name reverts, and the `_fieldsModified` entry
 * that would have raised a conflict next time reverts with it.
 *
 * Two rules, both derived from the one the merge itself uses — the later stamp
 * wins:
 *
 * - stamps are combined per field, keeping the later of the two, so a merge can
 *   never lower one;
 * - a field the stored record stamped **after** the merge read it keeps its
 *   stored value, because that edit is strictly newer than anything the merge
 *   could have known about. It is then still stamped, so the next merge sees it
 *   and can raise a conflict properly.
 *
 * @param merged - The record the merge produced
 * @param stored - The record as it is in IndexedDB right now, if it exists
 * @param localReadAt - When the merge read its local snapshot. Omit for a write
 *   that is not merge-derived — an authoritative pull of a read-only profile
 *   has no local edits to protect and must not keep local values.
 * @returns A copy of `merged` with newer local edits and stamps carried across
 */
export const reconcileWithStoredRecord = <T extends Syncable>(
  merged: T,
  stored: T | undefined,
  localReadAt?: number,
): T => {
  if (!stored) return merged;

  const storedStamps = stored._fieldsModified ?? {};
  const mergedStamps = merged._fieldsModified ?? {};
  const reconciled: T = { ...merged };
  const stamps: Record<string, number> = { ...mergedStamps };

  for (const [field, storedStamp] of Object.entries(storedStamps)) {
    if (storedStamp > (stamps[field] ?? 0)) stamps[field] = storedStamp;
    if (
      localReadAt !== undefined &&
      storedStamp > localReadAt &&
      isContentField(field) &&
      field in stored
    ) {
      (reconciled as unknown as Record<string, unknown>)[field] = (
        stored as unknown as Record<string, unknown>
      )[field];
    }
  }

  reconciled._fieldsModified = stamps;
  return reconciled;
};

const compareSyncableItems = (
  localItem: Syncable,
  remoteItem: Syncable,
  localLastSync: number,
  remoteLastSync: number,
): CompareItemResult => {
  const fieldConflicts: FieldConflict[] = [];
  let isConflict = false;
  const mergedItem = deepClone(localItem);
  const mergedFieldsModified = { ...(localItem._fieldsModified ?? {}) };
  const localFields = localItem._fieldsModified ?? {};
  const remoteFields = remoteItem._fieldsModified ?? {};
  const isVotingField = (k: string) =>
    !k.startsWith("_") &&
    k !== "id" &&
    k !== "createdAt" &&
    k !== "updatedAt" &&
    // Derived views do not vote; they follow the field they derive from.
    !DERIVED_HASH_FIELDS.has(k);
  const allFields = new Set([
    ...Object.keys(localItem).filter(isVotingField),
    ...Object.keys(remoteItem).filter(isVotingField),
  ]);
  let localWinsOverall = false;
  let remoteWinsOverall = false;

  /**
   * Adopts remote's value for a field, and with it remote's hash-keyed view of
   * the same fact. When remote has no such view — an older client that predates
   * hashing — the local one is dropped rather than kept, since keeping it would
   * describe remote's sounds with local's hashes, which is the corruption this
   * is here to prevent.
   */
  const adoptRemoteValue = (field: string, key: keyof Syncable) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mergedItem as any)[key] = remoteItem[key];

    const twin = DERIVED_HASH_TWINS[field];
    if (!twin) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = mergedItem as any;
    if (twin in remoteItem) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      merged[twin] = (remoteItem as any)[twin];
    } else {
      delete merged[twin];
    }
  };

  allFields.forEach((field) => {
    const key = field as keyof Syncable;
    const localMod = localFields[field] ?? 0;
    const remoteMod = remoteFields[field] ?? 0;
    const localVal = localItem[key];
    const remoteVal = remoteItem[key];
    const valuesDiffer = JSON.stringify(localVal) !== JSON.stringify(remoteVal);
    const localChangedSinceRemoteSync = localMod > remoteLastSync;
    const remoteChangedSinceLocalSync = remoteMod > localLastSync;

    if (
      localChangedSinceRemoteSync &&
      remoteChangedSinceLocalSync &&
      valuesDiffer
    ) {
      isConflict = true;
      fieldConflicts.push({
        field,
        localValue: localVal,
        remoteValue: remoteVal,
        localModTime: localMod,
        remoteModTime: remoteMod,
      });
    } else if (remoteChangedSinceLocalSync && valuesDiffer) {
      adoptRemoteValue(field, key);
      mergedFieldsModified[field] = remoteMod;
      remoteWinsOverall = true;
    } else if (localChangedSinceRemoteSync && valuesDiffer) {
      mergedFieldsModified[field] = localMod;
      localWinsOverall = true;
    } else {
      // No entry at all for a field neither side has ever stamped, rather than
      // an explicit 0 — see `stampMergedField` for what a 0 costs once this
      // record is written back over the stored one.
      stampMergedField(
        mergedFieldsModified,
        field,
        Math.max(localMod, remoteMod),
      );
      if (
        valuesDiffer &&
        (remoteItem._modified ?? 0) > (localItem._modified ?? 0)
      ) {
        adoptRemoteValue(field, key);
        remoteWinsOverall = true;
      } else if (valuesDiffer) {
        localWinsOverall = true;
      }
    }
  });

  let winner: "local" | "remote" | "none" = "none";
  if (!isConflict) {
    if (remoteWinsOverall && !localWinsOverall) winner = "remote";
    else if (localWinsOverall && !remoteWinsOverall) winner = "local";
    mergedItem._created = Math.min(
      localItem._created ?? Date.now(),
      remoteItem._created ?? Date.now(),
    );
    mergedItem._modified = Math.max(
      localItem._modified ?? 0,
      remoteItem._modified ?? 0,
    );
    mergedItem._fieldsModified = mergedFieldsModified;
  }

  return {
    isConflict,
    fieldConflicts,
    winner,
    mergedItem: isConflict ? null : mergedItem,
  };
};

// --- Helper: Compare Arrays of Syncable Items ---
interface CompareArrayResult<T extends Syncable> {
  conflicts: ItemConflict[];
  mergedItems: T[];
}

const compareSyncableArrays = <T extends Syncable>(
  localArray: T[],
  remoteArray: T[],
  getKey: (item: T) => string,
  storeName: "padConfigurations" | "pageMetadata",
  localLastSync: number,
  remoteLastSync: number,
): CompareArrayResult<T> => {
  const conflicts: ItemConflict[] = [];
  const mergedItems: T[] = [];
  const localMap = new Map(localArray.map((item) => [getKey(item), item]));
  const remoteMap = new Map(remoteArray.map((item) => [getKey(item), item]));
  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys()]);

  allKeys.forEach((key) => {
    const localItem = localMap.get(key);
    const remoteItem = remoteMap.get(key);

    if (localItem && remoteItem) {
      const compareResult = compareSyncableItems(
        localItem,
        remoteItem,
        localLastSync,
        remoteLastSync,
      );
      if (compareResult.isConflict) {
        conflicts.push({
          storeName,
          key,
          id: localItem.id ?? remoteItem.id,
          type: "field_conflict",
          localItem,
          remoteItem,
          fieldConflicts: compareResult.fieldConflicts,
        });
      } else if (compareResult.mergedItem) {
        mergedItems.push(compareResult.mergedItem as T);
      }
    } else if (localItem) {
      const localCreated = localItem._created ?? 0;
      // Against *our* last sync, not the remote's last write. The question is
      // "did this appear since I last looked at the remote", and only
      // `localLastSync` answers it: `remoteLastSync` is stamped by every push
      // including one that changed nothing, so a peer syncing first was enough
      // to make a pad you had just made look like one the remote had deleted.
      if (localCreated > localLastSync) {
        mergedItems.push(localItem);
      } else {
        conflicts.push({
          storeName,
          key,
          id: localItem.id,
          type: "local_only",
          localItem,
          remoteItem: null,
        });
      }
    } else if (remoteItem) {
      const remoteCreated = remoteItem._created ?? 0;
      if (remoteCreated > localLastSync) {
        mergedItems.push(remoteItem);
      } else {
        conflicts.push({
          storeName,
          key,
          id: remoteItem.id,
          type: "remote_only",
          localItem: null,
          remoteItem,
        });
      }
    }
  });

  return { conflicts, mergedItems };
};

/**
 * Profile fields that describe *where* a profile syncs rather than what it
 * contains. They are per-device bookkeeping — comparing them across devices
 * would raise conflicts over values that are legitimately different on each.
 */
const PROFILE_LOCATION_FIELDS = new Set([
  // Where the profile itself syncs.
  "syncType",
  "googleDriveFileId",
  "serverProfileId",
  "serverVersion",
  "serverShareToken",
  // Where its audio lives. `googleDriveFolderId` used to travel, which is how
  // a collaborator ended up holding the *owner's* folder id and then tried to
  // upload into it — silently, because those failures are non-fatal.
  "audioLocation",
  "googleDriveFolderId",
  // What we may do with it, and whether we are doing it right now. Both are
  // answers about this device's access and this device's choice.
  "serverRole",
  "readOnly",
  // Following is this device's decision about this device. Letting it travel
  // would mean one person choosing to follow silently stopped everyone else
  // contributing.
  "followOnly",
  "syncPausedUntil",
]);

const isComparableProfileField = (key: string): boolean =>
  !key.startsWith("_") &&
  key !== "id" &&
  key !== "createdAt" &&
  key !== "updatedAt" &&
  !PROFILE_LOCATION_FIELDS.has(key);

// --- Data Structure for Syncing ---
// Represents the entire dataset to be synced for a specific profile
// This structure will be stored as a single JSON file per profile in Drive
/**
 * A pad as it travels, which is not quite a pad as it is stored.
 *
 * `audioFileIds` are IndexedDB autoincrement keys, so id 3 names a different
 * recording on every device. Everything a reader does with them depends on
 * knowing whose ids they are, and the merge could not know: it translated
 * every pad through a map keyed by the sender, so a pad the remote had never
 * touched came back pointing at a different sound, and was then published.
 *
 * The hash fields are the answer, and they are additive on purpose. A content
 * hash means the same thing on every device, so a reader that understands
 * these never has to ask who wrote the pad. A client running older code still
 * finds the id fields exactly where they were, so no migration and no compat
 * window is needed: the two describe the same pad, and the hashes simply win
 * wherever both are present.
 */
export interface SyncedPadConfiguration extends PadConfiguration {
  /**
   * Content hashes for `audioFileIds`, in the same order and the same length.
   * An entry is null for audio that predates hashing, which falls back to the
   * id.
   */
  audioFileHashes?: (string | null)[];
  audioTrimSettingsByHash?: Record<
    string,
    { trimStart: number; trimEnd: number }
  >;
  audioGainSettingsByHash?: Record<string, number>;
}

export interface ProfileSyncData {
  _syncFormatVersion: number; // To handle future format changes
  _lastSyncTimestamp?: number; // Timestamp of the last successful sync with this file
  /**
   * The profile metadata itself, reduced to the fields that may leave a
   * device — see `lib/profileWire`. A blob written by an older client can
   * still *contain* more than this; the type says what we rely on and what we
   * are willing to write back out.
   */
  profile: WireProfile;
  padConfigurations: SyncedPadConfiguration[];
  pageMetadata: PageMetadata[];
  // Include audio files to ensure complete sync
  audioFiles: {
    id: number;
    name: string;
    type: string;
    hash?: string; // SHA-256 hex digest of blob content
    driveFileId?: string; // Google Drive file ID (preferred — separate Drive file per audio)
    // Set when the bytes are hosted by this app's own server (optional, gated
    // Wasabi storage). Collaborators then fetch via /api/profiles/:id/audio/:hash
    // instead of Drive. Absent for every profile whose audio lives in Drive.
    serverHosted?: boolean;
    data?: string; // Base64 encoded audio data (legacy fallback for backward compat)
  }[];
}

/**
 * Which remote a conflict is against.
 *
 * The merge is backend-agnostic — `detectProfileConflicts` is the same code
 * for both — but resolving one is not: a Drive conflict is settled by writing
 * a file, a server one by a version-checked push. Carrying the origin with the
 * conflict is what lets a single modal serve both, instead of one modal whose
 * copy says "Google Drive" no matter which backend it is talking about.
 */
export type ConflictOrigin =
  | { kind: "drive"; fileId: string }
  | { kind: "server"; serverProfileId: string; version: number };

/** How to name the other side of a conflict, in a sentence. */
export const conflictOriginLabel = (origin: ConflictOrigin): string =>
  origin.kind === "drive" ? "Google Drive" : "the ImpAmp server";

/**
 * Gives a bank or pad from an incoming blob a `bankId`, for a blob written
 * before this device's data was migrated to identity — see
 * `normaliseIncomingSyncData`, which calls this once per bank and once per
 * pad.
 *
 * `PageMetadata` and `PadConfiguration` both type `bankId` as required —
 * that describes what this client always writes, not what a downloaded blob
 * is guaranteed to hold. A blob is parsed JSON, not a type-checked value, so
 * an old one simply lacks the field at runtime and TypeScript cannot see it.
 * Read `item.bankId` on such a record and every one of them reads as the
 * same `undefined`, which every consumer downstream — the merge, the diff
 * summary's sort, a direct write with no merge at all — would then treat as
 * one bank (or one pad per position) shared by every profile on every
 * device.
 *
 * The fallback mints the identity the local migration already gave this
 * data: `migratedBankId(pageIndex)`. Using any other rule here would create
 * a second convention that has to agree with the first one by coincidence,
 * which is exactly the kind of duplicated rule that drifts. A record's
 * incoming `pageIndex` is read from the raw object rather than the current
 * `PadConfiguration`/`PageMetadata` type, because an old blob's rows still
 * carry it even though a pad's type no longer declares it.
 *
 * Matches `migrateToV7`'s refusal too: a record with neither `bankId` nor
 * `pageIndex` cannot be placed. Defaulting it to bank 0 would silently file
 * it under a real bank it may have nothing to do with, so — exactly as the
 * migration does — it is left without a `bankId`, logged, and otherwise
 * unchanged, rather than guessed at.
 *
 * @param item - A bank or pad as it arrived in the blob
 * @param kind - Only for the log line, so a warning names what it is about
 * @returns The item, given a `bankId` when one could be minted
 */
const withMigratedBankId = <
  T extends { bankId?: string; id?: number; profileId: number },
>(
  item: T,
  kind: "bank" | "pad",
): T => {
  if (item.bankId != null) return item;
  const pageIndex = (item as unknown as { pageIndex?: number }).pageIndex;
  if (pageIndex === undefined) {
    console.warn(
      `Sync: incoming ${kind} ${item.id ?? "(no id)"} on profile ${item.profileId} has neither bankId nor pageIndex; leaving it unmigrated.`,
    );
    return item;
  }
  return { ...item, bankId: migratedBankId(pageIndex) };
};

/**
 * Strips a pad's own copy of `pageIndex`, which `migrateToV7` deletes too.
 *
 * A pad's position is its bank's position — `PadConfiguration` has not
 * declared `pageIndex` since the identity migration — so a legacy blob's
 * copy surviving into `mergedData` is stale the moment it arrives. Left in
 * place, `isContentField` counts it as content the merge has an opinion
 * about, and `updateLocalData` would write it back into IndexedDB.
 */
const stripPadPageIndex = (
  pad: SyncedPadConfiguration,
): SyncedPadConfiguration => {
  const raw = pad as unknown as Record<string, unknown>;
  if (!("pageIndex" in raw)) return pad;
  const { pageIndex: _pageIndex, ...rest } = raw;
  return rest as unknown as SyncedPadConfiguration;
};

/**
 * Normalises an incoming sync blob so every bank and pad that can be given a
 * `bankId` has one, for a blob written before this device's data was
 * migrated to identity — see `withMigratedBankId`.
 *
 * Call this exactly once, at the point a blob arrives from the network, so
 * one normalised blob flows onward and no consumer downstream — the merge,
 * `describesSameSyncState`'s diff summary, or a read-only pull that writes
 * straight to IndexedDB with no merge at all — can receive the raw one.
 * Putting the fix inside the merge alone was tried and was not enough:
 * `describesSameSyncState` compares a merge's *output* against the raw
 * remote blob, which never passes through the merge, and a read-only pull
 * never calls the merge either.
 *
 * @param data - The blob as it arrived, `bankId` absent or present
 * @returns A new blob; every bank/pad that could be given a `bankId` has one,
 *   and no pad carries its own `pageIndex`
 */
export const normaliseIncomingSyncData = (
  data: ProfileSyncData,
): ProfileSyncData => ({
  ...data,
  pageMetadata: (data.pageMetadata ?? []).map((page) =>
    withMigratedBankId(page, "bank"),
  ),
  padConfigurations: (data.padConfigurations ?? []).map((pad) =>
    stripPadPageIndex(withMigratedBankId(pad, "pad")),
  ),
});

/**
 * Detects conflicts between local and remote sync data for a single profile.
 * @param localData Local version of ProfileSyncData.
 * @param remoteData Remote version of ProfileSyncData.
 * @returns An object containing conflicts and potentially automatically merged data.
 */
export const detectProfileConflicts = async (
  localData: ProfileSyncData,
  remoteData: ProfileSyncData | null,
): Promise<{
  conflicts: ItemConflict[];
  requiresManualResolution: boolean;
  mergedData: ProfileSyncData;
}> => {
  const conflicts: ItemConflict[] = [];
  let requiresManualResolution = false;

  // Start with local data as the base for the merged result
  // We'll update fields based on remote data if it's newer and non-conflicting
  const mergedData = deepClone(localData); // Use deepClone to avoid modifying original local data

  if (!remoteData) {
    // No remote data exists, treat everything local as new (no conflicts)
    console.log("No remote data found, using local data as is.");
    return { conflicts, requiresManualResolution, mergedData };
  }

  // Defensive belt, not the fix itself: every caller is now expected to hand
  // in an already-normalised blob (see `normaliseIncomingSyncData`), but
  // normalising again here is idempotent and cheap, and this function is
  // reachable from a test or a future caller that forgets to. Calling the
  // same function rather than a second implementation is what keeps this
  // from becoming a duplicated rule.
  const normalisedRemoteData = normaliseIncomingSyncData(remoteData);
  const remotePageMetadata = normalisedRemoteData.pageMetadata;
  const remotePadConfigurations = normalisedRemoteData.padConfigurations;

  // --- 1. Compare Profile Metadata ---
  const profileConflicts: FieldConflict[] = [];
  const localProfile = localData.profile;
  const remoteProfile = remoteData.profile;
  const localProfileFields = localProfile._fieldsModified ?? {};
  const remoteProfileFields = remoteProfile._fieldsModified ?? {};
  const allProfileFields = new Set([
    ...Object.keys(localProfile).filter(isComparableProfileField),
    ...Object.keys(remoteProfile).filter(isComparableProfileField),
  ]);

  allProfileFields.forEach((field) => {
    // A blob written by an older client can carry fields the wire shape no
    // longer includes (`serverShareToken`); `isComparableProfileField` has
    // already filtered those out, so the cast only covers shared fields.
    const key = field as keyof WireProfile;
    const localMod = localProfileFields[field] ?? 0;
    const remoteMod = remoteProfileFields[field] ?? 0;
    const localVal = localProfile[key];
    const remoteVal = remoteProfile[key];
    const stamps = (mergedData.profile._fieldsModified ??= {});

    if (
      localMod > (remoteData._lastSyncTimestamp ?? 0) &&
      remoteMod > (localData._lastSyncTimestamp ?? 0) &&
      JSON.stringify(localVal) !== JSON.stringify(remoteVal)
    ) {
      // Conflict: Both modified since last sync and values differ
      profileConflicts.push({
        field,
        localValue: localVal,
        remoteValue: remoteVal,
        localModTime: localMod,
        remoteModTime: remoteMod,
      });
      requiresManualResolution = true;
      // Undecided, so the merged record still holds local's value and keeps
      // local's stamp with it.
      stampMergedField(stamps, field, stamps[field] ?? localMod);
    } else if (remoteMod > localMod) {
      // Remote is newer, update merged data
      // Use 'any' cast for dynamic property assignment, disabling ESLint for this line
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mergedData.profile as any)[key] = remoteVal;
      stampMergedField(stamps, field, remoteMod);
    } else {
      // Local is newer or the two are tied, so local's value stands — it is
      // already in `mergedData` — and so does the stamp that came with it. A
      // field neither side has ever stamped gets no entry at all; see
      // `stampMergedField` for what an explicit 0 costs.
      stampMergedField(stamps, field, stamps[field] || localMod);
    }
  });

  if (profileConflicts.length > 0) {
    conflicts.push({
      storeName: "profiles",
      key: localProfile.id!, // Add the required key property
      id: localProfile.id!,
      type: "field_conflict",
      localItem: localProfile as Syncable, // Cast to Syncable
      remoteItem: remoteProfile as Syncable, // Cast to Syncable
      fieldConflicts: profileConflicts,
    });
  }
  // Update overall profile modified timestamp in merged data
  mergedData.profile._modified = Math.max(
    localProfile._modified ?? 0,
    remoteProfile._modified ?? 0,
  );

  // Define last sync timestamps (handle potential undefined/null)
  const localLastSync = localData._lastSyncTimestamp ?? 0;
  const remoteLastSync = remoteData._lastSyncTimestamp ?? 0;

  // --- 2. Compare Pad Configurations ---
  const padConfigKeyExtractor = (item: PadConfiguration) =>
    `${item.bankId}-${item.padIndex}`;
  const padConfigResult = compareSyncableArrays(
    // Let type inference work
    localData.padConfigurations,
    remotePadConfigurations,
    padConfigKeyExtractor, // No cast needed
    "padConfigurations",
    localLastSync,
    remoteLastSync,
  );
  conflicts.push(...padConfigResult.conflicts);
  mergedData.padConfigurations = padConfigResult.mergedItems; // Direct assignment should work now
  if (padConfigResult.conflicts.length > 0) {
    requiresManualResolution = true;
  }

  // --- 3. Compare Page Metadata ---
  const pageMetaKeyExtractor = (item: PageMetadata) => item.bankId;
  const pageMetaResult = compareSyncableArrays(
    // Let type inference work
    localData.pageMetadata,
    remotePageMetadata,
    pageMetaKeyExtractor, // No cast needed
    "pageMetadata",
    localLastSync,
    remoteLastSync,
  );
  conflicts.push(...pageMetaResult.conflicts);
  mergedData.pageMetadata = pageMetaResult.mergedItems; // Direct assignment should work now
  if (pageMetaResult.conflicts.length > 0) {
    requiresManualResolution = true;
  }

  // --- Translate remote audio IDs to local IDs in merged pad configs ---
  // audioFileIds are local IndexedDB auto-increment keys (device-specific).
  // When a remote pad config "wins" a field merge, its audioFileIds reference
  // remote IDs that may not exist locally. Translate them via content hash.
  if (remoteData.audioFiles?.length) {
    // Build hash→localId map, computing hashes lazily for local files that lack one
    const localHashToId = new Map<string, number>();
    for (const localFile of localData.audioFiles) {
      if (localFile.id === undefined) continue;
      const hash = localFile.hash
        ? localFile.hash
        : await ensureAudioFileHash(localFile.id);
      if (hash) localHashToId.set(hash, localFile.id);
    }

    // Map: remote audio ID → local audio ID (matched by content hash)
    const remoteToLocalIdMap = new Map<number, number>();
    for (const remoteFile of remoteData.audioFiles) {
      if (!remoteFile.hash) continue;
      const localId = localHashToId.get(remoteFile.hash);
      if (localId !== undefined) {
        remoteToLocalIdMap.set(remoteFile.id, localId);
      }
    }

    if (remoteToLocalIdMap.size > 0) {
      mergedData.padConfigurations = mergedData.padConfigurations.map((pad) => {
        // A pad that names its audio by hash needs no translation, and must
        // not be given any: the map is keyed by the sender's ids, and this pad
        // may never have come from the sender. Translating it anyway is what
        // turned a local pad's kick into a snare.
        if (pad.audioFileHashes?.length) return pad;

        const translatedIds = pad.audioFileIds?.map(
          (id) => remoteToLocalIdMap.get(id) ?? id,
        );

        // A remote ID with no local match is kept under its original ID
        // (rather than dropped) — this merge path isn't discarding audio
        // files the way import/Drive-write can, so the setting should
        // survive under whatever ID eventually resolves it.
        const translatedTrimSettings = remapPadSettingsOnMerge(
          pad.audioTrimSettings,
          remoteToLocalIdMap,
        );
        const translatedGainSettings = remapPadSettingsOnMerge(
          pad.audioGainSettings,
          remoteToLocalIdMap,
        );

        return {
          ...pad,
          audioFileIds: translatedIds ?? pad.audioFileIds,
          audioTrimSettings: translatedTrimSettings,
          audioGainSettings: translatedGainSettings,
        };
      });
    }

    // Add audio files from remote that don't exist locally so updateLocalData
    // can import them and build the correct ID mapping for new files.
    // Hash-less legacy entries carry their audio inline, so they are deduped by
    // name and type instead — re-appending them would grow the Drive JSON on
    // every sync.
    const localAudioHashes = new Set([...localHashToId.keys()]);
    const mergedAudioKeys = new Set(
      mergedData.audioFiles.map((f) => f.hash ?? `${f.name}|${f.type}`),
    );
    // Ids are the sender's, so an appended entry can land on one already in
    // use. Two entries sharing an id makes the blob ambiguous for everyone:
    // `updateLocalData` builds its map in list order, so the second silently
    // wins and pads resolve to the other recording.
    const usedIds = new Set(mergedData.audioFiles.map((f) => f.id));
    let nextFreeId = Math.max(0, ...usedIds) + 1;

    for (const remoteFile of remoteData.audioFiles) {
      if (remoteFile.hash && localAudioHashes.has(remoteFile.hash)) continue;
      const key = remoteFile.hash ?? `${remoteFile.name}|${remoteFile.type}`;
      if (mergedAudioKeys.has(key)) continue;
      mergedAudioKeys.add(key);

      const id = usedIds.has(remoteFile.id) ? nextFreeId++ : remoteFile.id;
      usedIds.add(id);
      mergedData.audioFiles.push({ ...remoteFile, id });
    }
  }

  // --- Final Merge Metadata ---
  // Set the timestamp for the *merged* data before returning/uploading
  mergedData._lastSyncTimestamp = Date.now();

  console.log(
    `Conflict detection complete. Found ${conflicts.length} conflicts. Requires manual resolution: ${requiresManualResolution}`,
  );
  return { conflicts, requiresManualResolution, mergedData };
};

/**
 * Which local audio a synced pad should end up pointing at.
 *
 * Synced ids are the *sender's*, so each has to be translated. An id that
 * cannot be translated is dropped rather than kept: kept, it would address a
 * different recording on this device, and a silent pad beats the wrong sound.
 *
 * Dropping *every* reference is another matter. It is right for a pad new to
 * this device, and destructive for one that already plays something: the sound
 * is here and wired up, and only its description is untranslatable. Emptying
 * it loses local work, and the emptied pad is pushed back on the next sync, so
 * everyone loses it.
 */
export function resolveSyncedPadAudio(
  syncedIds: number[],
  audioIdMap: Map<number, number>,
  existingIds: number[] | undefined,
  /**
   * Hashes for `syncedIds`, in the same order, and a hash→local-id lookup.
   * Preferred where both are present: a hash names the same recording on every
   * device, so it needs no translation and cannot be misread.
   */
  syncedHashes?: (string | null)[],
  localIdByHash?: Map<string, number>,
): { audioFileIds: number[]; keptLocal: boolean; unresolved: number[] } {
  const audioFileIds: number[] = [];
  const unresolved: number[] = [];

  for (const [index, syncedId] of syncedIds.entries()) {
    const hash = syncedHashes?.[index];
    if (hash && localIdByHash) {
      const byHash = localIdByHash.get(hash);
      if (byHash !== undefined) {
        audioFileIds.push(byHash);
      } else {
        unresolved.push(syncedId);
      }
      continue;
    }

    const localId = audioIdMap.get(syncedId);
    if (localId === undefined) unresolved.push(syncedId);
    else audioFileIds.push(localId);
  }

  // Any reference we could not resolve means audio that has not arrived, not
  // audio someone removed: a removal simply would not be in the blob. Writing
  // what did resolve would publish a pad with the missing sounds edited out,
  // and every other device would then drop them too. Holding the local set
  // costs nothing, because the next sync resolves them once the audio lands.
  //
  // Only a partial failure used to be treated this way when *nothing*
  // resolved, so a three-sound pad missing one came back with two.
  if (unresolved.length > 0 && existingIds?.length) {
    return { audioFileIds: existingIds, keptLocal: true, unresolved };
  }
  return { audioFileIds, keptLocal: false, unresolved };
}

/**
 * A sync blob reduced to what it actually tells the *other* side.
 *
 * Two devices holding identical boards do not hold identical blobs, and cannot:
 * `audioFileIds` are IndexedDB autoincrement keys, so id 3 names a different
 * recording on every device, and the same is true of both settings maps keyed
 * by them and of every `audioFiles[].id`. Compared literally, two blobs saying
 * exactly the same thing look different every time.
 *
 * So each of those is dropped in favour of the hash-keyed twin that says the
 * same thing in terms every device shares, audio is keyed by content hash
 * rather than by id, and the profile is reduced to the fields the merge
 * actually compares — the rest are this device's answers about itself and were
 * never the remote's business.
 *
 * Key order is normalised too, because one side built its blob and the other
 * parsed it back out of JSON.
 */
const remoteFacingView = (data: ProfileSyncData): unknown => {
  const sortedStamps = (
    stamps: Record<string, number> | undefined,
    include: (key: string) => boolean,
  ) =>
    Object.entries(stamps ?? {})
      .filter(([key]) => include(key))
      .sort(([a], [b]) => a.localeCompare(b));

  const itemView = (item: Record<string, unknown>) => {
    const supersededByTwin = (key: string) => {
      const twin = DERIVED_HASH_TWINS[key];
      return twin !== undefined && item[twin] !== undefined;
    };
    const says = (key: string) => isContentField(key) && !supersededByTwin(key);
    return {
      fields: Object.keys(item)
        .filter(says)
        .sort()
        .map((key) => [key, item[key]] as const),
      stamps: sortedStamps(
        item._fieldsModified as Record<string, number> | undefined,
        (key) => !supersededByTwin(key),
      ),
    };
  };

  const profile = data.profile as unknown as Record<string, unknown>;
  return {
    profile: {
      fields: Object.keys(profile)
        .filter(isComparableProfileField)
        .sort()
        .map((key) => [key, profile[key]] as const),
      stamps: sortedStamps(
        data.profile._fieldsModified,
        isComparableProfileField,
      ),
    },
    pads: [...data.padConfigurations]
      .sort(
        (a, b) => a.bankId.localeCompare(b.bankId) || a.padIndex - b.padIndex,
      )
      .map((pad) => itemView(pad as unknown as Record<string, unknown>)),
    pages: [...data.pageMetadata]
      .sort((a, b) => a.bankId.localeCompare(b.bankId))
      .map((page) => itemView(page as unknown as Record<string, unknown>)),
    audio: (data.audioFiles ?? [])
      .map((file) => ({
        key: file.hash ?? `name:${file.name}`,
        type: file.type,
        driveFileId: file.driveFileId ?? null,
        serverHosted: file.serverHosted ?? false,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
};

/**
 * Whether two sync blobs would tell a reader the same thing.
 *
 * Used to decide whether a merge is worth pushing. It has to be true whenever
 * the remote already knows everything the merge produced, and false whenever it
 * does not — a false positive silently drops the user's edit, and a false
 * negative is only wasted work.
 *
 * @param a - One blob
 * @param b - The other
 * @returns true when neither would teach the other anything
 */
export const describesSameSyncState = (
  a: ProfileSyncData,
  b: ProfileSyncData,
): boolean =>
  JSON.stringify(remoteFacingView(a)) === JSON.stringify(remoteFacingView(b));

/** What the user chose for one conflicting item, or for one of its fields. */
export type ResolutionChoice =
  "local" | "remote" | "keep" | "delete" | "accept" | "discard";

/** Per-field choices for a `field_conflict`, keyed by field name. */
export type FieldResolutions = Record<string, ResolutionChoice>;

/** Every choice the user has made, keyed by `ItemConflict.key`. */
export type ConflictResolutionState = Record<
  string | number,
  ResolutionChoice | FieldResolutions
>;

/**
 * Applies a set of hand-made conflict resolutions to the automatic merge.
 *
 * This belongs here, beside `compareSyncableItems`, because it is the same rule
 * set applied by a person instead of by a timestamp — and the two have to
 * agree. It lived in the modal instead, and drifted: the automatic merge
 * learned that a hash-keyed field follows whichever side won the field it
 * derives from (`DERIVED_HASH_TWINS`), and the hand-resolved path did not.
 * Choosing "use the remote version" for `audioFileIds` wrote the remote's ids
 * beside the *local* hashes, and `updateLocalData` believes the hashes — so the
 * user was handed back their own sounds, or a mixture of both devices', from
 * the one path where they had been asked explicitly.
 *
 * Pure, so it can be tested without a modal: same inputs, same blob, and no
 * clock except the one passed in.
 *
 * @param merged - The automatic merge; conflicting items are absent from it
 * @param conflicts - The conflicts that were presented to the user
 * @param resolutions - The user's choices, keyed by conflict key
 * @param now - The timestamp to stamp the resolution with
 * @returns A new blob with every resolved conflict applied
 */
export const applyConflictResolutions = (
  merged: ProfileSyncData,
  conflicts: ItemConflict[],
  resolutions: ConflictResolutionState,
  now: number = Date.now(),
): ProfileSyncData => {
  // Start from the automatically merged data so every non-conflicting remote
  // change survives; only the flagged conflicts are decided here
  const resolved = deepClone(merged);

  const resolvedPadConfigs = new Map(
    resolved.padConfigurations.map((p) => [`${p.bankId}-${p.padIndex}`, p]),
  );
  const resolvedPageMeta = new Map(
    resolved.pageMetadata.map((p) => [p.bankId, p]),
  );

  conflicts.forEach((conflict) => {
    const keyStr = String(conflict.key);
    const resolution = resolutions[keyStr];
    if (!resolution) return;

    // Conflicting items are held back from the merged base, so they have to
    // be seeded from their local version before the choices are applied
    const seedFromLocal = (): Syncable | null => {
      const source = conflict.localItem ?? conflict.remoteItem;
      return source ? (deepClone(source) as Syncable) : null;
    };

    switch (conflict.type) {
      case "field_conflict": {
        const fieldResolutions = resolution as FieldResolutions;
        let targetItem: Syncable | undefined | null = null;

        if (conflict.storeName === "profiles") {
          targetItem = resolved.profile as Syncable;
        } else if (conflict.storeName === "padConfigurations") {
          targetItem = resolvedPadConfigs.get(keyStr);
          if (!targetItem) {
            targetItem = seedFromLocal();
            if (targetItem)
              resolvedPadConfigs.set(
                keyStr,
                targetItem as SyncedPadConfiguration,
              );
          }
        } else if (conflict.storeName === "pageMetadata") {
          targetItem = resolvedPageMeta.get(keyStr);
          if (!targetItem) {
            targetItem = seedFromLocal();
            if (targetItem)
              resolvedPageMeta.set(keyStr, targetItem as PageMetadata);
          }
        }

        if (!targetItem) break;
        const item = targetItem;
        let itemModified = false;

        conflict.fieldConflicts?.forEach((fc) => {
          const choice = fieldResolutions[fc.field];
          if (choice !== "local" && choice !== "remote") return;

          const chosenSide =
            choice === "local" ? conflict.localItem : conflict.remoteItem;
          const value = choice === "local" ? fc.localValue : fc.remoteValue;
          const modTime =
            choice === "local" ? fc.localModTime : fc.remoteModTime;
          const fields = item as unknown as Record<string, unknown>;

          if (JSON.stringify(fields[fc.field]) !== JSON.stringify(value)) {
            fields[fc.field] = value;
            itemModified = true;
          }

          // The chosen side's hash-keyed view of the same fact travels with it,
          // exactly as `adoptRemoteValue` does in the automatic merge. Without
          // this, the pad's ids come from one device and its hashes from the
          // other, and the hashes are what the writer believes.
          const twin = DERIVED_HASH_TWINS[fc.field];
          if (twin) {
            const twinValue = (
              chosenSide as unknown as
                Record<string, unknown> | null | undefined
            )?.[twin];
            if (twinValue === undefined) delete fields[twin];
            else fields[twin] = twinValue;
            itemModified = true;
          }

          item._fieldsModified ??= {};
          item._fieldsModified[fc.field] = modTime;
        });

        // Update the overall modified time only if a field actually changed value
        if (itemModified) {
          item._modified = now;
        } else {
          // If only timestamps changed, still update _modified to latest of the chosen fields
          const latestFieldMod = conflict.fieldConflicts
            ? Math.max(
                0,
                ...conflict.fieldConflicts.map((fc) =>
                  fieldResolutions[fc.field] === "local"
                    ? fc.localModTime
                    : fc.remoteModTime,
                ),
              )
            : 0;
          item._modified = Math.max(item._modified ?? 0, latestFieldMod);
        }
        break;
      }
      case "local_only": {
        if (resolution === "delete") {
          if (conflict.storeName === "padConfigurations") {
            resolvedPadConfigs.delete(keyStr);
          } else if (conflict.storeName === "pageMetadata") {
            resolvedPageMeta.delete(keyStr);
          }
        }
        // If 'keep', restore the local item and mark it as touched by this sync
        else if (resolution === "keep") {
          const targetItem = seedFromLocal();
          if (targetItem) {
            targetItem._modified = now;
            if (conflict.storeName === "padConfigurations")
              resolvedPadConfigs.set(
                keyStr,
                targetItem as SyncedPadConfiguration,
              );
            else if (conflict.storeName === "pageMetadata")
              resolvedPageMeta.set(keyStr, targetItem as PageMetadata);
          }
        }
        break;
      }
      case "remote_only": {
        if (resolution === "accept" && conflict.remoteItem) {
          const itemToAdd = deepClone(conflict.remoteItem);
          // Ensure sync fields exist and mark every field modified now
          itemToAdd._created = itemToAdd._created ?? now;
          itemToAdd._modified = now;
          const stamps: Record<string, number> =
            itemToAdd._fieldsModified ?? {};
          Object.keys(itemToAdd).forEach((k) => {
            if (isContentField(k)) stamps[k] = now;
          });
          itemToAdd._fieldsModified = stamps;

          if (conflict.storeName === "padConfigurations") {
            resolvedPadConfigs.set(keyStr, itemToAdd as SyncedPadConfiguration);
          } else if (conflict.storeName === "pageMetadata") {
            resolvedPageMeta.set(keyStr, itemToAdd as PageMetadata);
          }
        }
        break;
      }
    }
  });

  resolved.padConfigurations = Array.from(resolvedPadConfigs.values());
  resolved.pageMetadata = Array.from(resolvedPageMeta.values());
  resolved._lastSyncTimestamp = now;

  // Ensure top-level profile _modified reflects the latest change
  const latestItemMod = Math.max(
    0,
    ...resolved.padConfigurations.map((p) => p._modified ?? 0),
    ...resolved.pageMetadata.map((p) => p._modified ?? 0),
  );
  resolved.profile._modified = Math.max(
    resolved.profile._modified ?? 0,
    latestItemMod,
    now,
  );

  return resolved;
};
