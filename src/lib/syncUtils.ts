import { Profile, PadConfiguration, PageMetadata } from "./db"; // Import main data types

// Type guard to check if an object has sync fields
// Exporting Syncable type for use in other modules
export type Syncable = (Profile | PadConfiguration | PageMetadata) & {
  id?: number;
  _created?: number;
  _modified?: number;
  _fieldsModified?: Record<string, number>;
};

/**
 * Merges two syncable items (Profile, PadConfiguration, PageMetadata) with field-level tracking.
 * Prefers the item with the most recent modification time for each field.
 * Handles nested objects/arrays with simple JSON string comparison.
 *
 * @param localItem The local version of the item.
 * @param remoteItem The remote version of the item from Drive.
 * @returns The merged item.
 */
export const mergeFieldBasedChanges = <T extends Syncable>(
  localItem: T,
  remoteItem: T,
): T => {
  // Start with a copy of the local item as the base for the merge result
  const result = { ...localItem };

  // Ensure sync metadata exists, defaulting if necessary
  const now = Date.now();
  const localCreated = localItem._created ?? now;
  const remoteCreated = remoteItem._created ?? now;
  const localModified = localItem._modified ?? localCreated;
  const remoteModified = remoteItem._modified ?? remoteCreated;
  const localFields = localItem._fieldsModified ?? {};
  const remoteFields = remoteItem._fieldsModified ?? {};

  // Gather all unique field names from both items (excluding internal DB/sync fields)
  const allFields = new Set([
    ...Object.keys(localItem).filter(
      (key) =>
        !key.startsWith("_") &&
        key !== "id" &&
        key !== "createdAt" &&
        key !== "updatedAt",
    ),
    ...Object.keys(remoteItem).filter(
      (key) =>
        !key.startsWith("_") &&
        key !== "id" &&
        key !== "createdAt" &&
        key !== "updatedAt",
    ),
  ]);

  const mergedFieldsModified: Record<string, number> = { ...localFields };

  // Iterate through each field to decide which version to keep
  allFields.forEach((field) => {
    const key = field as keyof T; // Assert key type

    const localModTime = localFields[field] ?? 0;
    const remoteModTime = remoteFields[field] ?? 0;
    const localValue = localItem[key];
    const remoteValue = remoteItem[key];

    // Determine if the values are different (using JSON.stringify for simple deep compare)
    const valuesDiffer =
      JSON.stringify(localValue) !== JSON.stringify(remoteValue);

    // Decision logic:
    // 1. If only remote was modified OR remote was modified more recently AND values differ: use remote
    if (
      (remoteModTime > 0 && localModTime === 0 && valuesDiffer) ||
      (remoteModTime > localModTime && valuesDiffer)
    ) {
      result[key] = remoteValue;
      mergedFieldsModified[field] = remoteModTime;
    }
    // 2. If only local was modified OR local was modified more recently AND values differ: keep local (already in result)
    else if (
      (localModTime > 0 && remoteModTime === 0 && valuesDiffer) ||
      (localModTime > remoteModTime && valuesDiffer)
    ) {
      // Keep local value (already spread)
      mergedFieldsModified[field] = localModTime; // Ensure timestamp is the local one
    }
    // 3. If both modified at the same time OR neither modified OR values are the same:
    //    Keep the value from the overall more recently modified record, update timestamp if needed.
    else {
      if (remoteModified > localModified && valuesDiffer) {
        result[key] = remoteValue; // Prefer remote if record is newer and values differ
      }
      // Update the timestamp in mergedFieldsModified to the latest known modification time for that field
      mergedFieldsModified[field] = Math.max(localModTime, remoteModTime);
    }
  });

  // Set the merged sync metadata
  result._created = Math.min(localCreated, remoteCreated); // Keep the earliest creation time
  result._modified = Math.max(localModified, remoteModified); // Use the latest modification time
  result._fieldsModified = mergedFieldsModified;

  return result;
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
  key: string | number; // Unique key (profile ID, pageIndex-padIndex, pageIndex)
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
  const allFields = new Set([
    ...Object.keys(localItem).filter(
      (k) =>
        !k.startsWith("_") &&
        k !== "id" &&
        k !== "createdAt" &&
        k !== "updatedAt",
    ),
    ...Object.keys(remoteItem).filter(
      (k) =>
        !k.startsWith("_") &&
        k !== "id" &&
        k !== "createdAt" &&
        k !== "updatedAt",
    ),
  ]);
  let localWinsOverall = false;
  let remoteWinsOverall = false;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mergedItem as any)[key] = remoteVal; // Cast to any for dynamic assignment
      mergedFieldsModified[field] = remoteMod;
      remoteWinsOverall = true;
    } else if (localChangedSinceRemoteSync && valuesDiffer) {
      mergedFieldsModified[field] = localMod;
      localWinsOverall = true;
    } else {
      mergedFieldsModified[field] = Math.max(localMod, remoteMod);
      if (
        valuesDiffer &&
        (remoteItem._modified ?? 0) > (localItem._modified ?? 0)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mergedItem as any)[key] = remoteVal; // Cast to any for dynamic assignment
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
      if (localCreated > remoteLastSync) {
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

// --- Data Structure for Syncing ---
// Represents the entire dataset to be synced for a specific profile
// This structure will be stored as a single JSON file per profile in Drive
export interface ProfileSyncData {
  _syncFormatVersion: number; // To handle future format changes
  _lastSyncTimestamp?: number; // Timestamp of the last successful sync with this file
  profile: Profile; // The profile metadata itself
  padConfigurations: PadConfiguration[];
  pageMetadata: PageMetadata[];
  // Include audio files to ensure complete sync
  audioFiles: {
    id: number;
    name: string;
    type: string;
    data: string; // Base64 encoded audio data
  }[];
}

/**
 * Detects conflicts between local and remote sync data for a single profile.
 * @param localData Local version of ProfileSyncData.
 * @param remoteData Remote version of ProfileSyncData.
 * @returns An object containing conflicts and potentially automatically merged data.
 */
export const detectProfileConflicts = (
  localData: ProfileSyncData,
  remoteData: ProfileSyncData | null,
): {
  conflicts: ItemConflict[];
  requiresManualResolution: boolean;
  mergedData: ProfileSyncData;
} => {
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

  // --- 1. Compare Profile Metadata ---
  const profileConflicts: FieldConflict[] = [];
  const localProfile = localData.profile;
  const remoteProfile = remoteData.profile;
  const localProfileFields = localProfile._fieldsModified ?? {};
  const remoteProfileFields = remoteProfile._fieldsModified ?? {};
  const allProfileFields = new Set([
    ...Object.keys(localProfile).filter(
      (k) =>
        !k.startsWith("_") &&
        k !== "id" &&
        k !== "createdAt" &&
        k !== "updatedAt",
    ),
    ...Object.keys(remoteProfile).filter(
      (k) =>
        !k.startsWith("_") &&
        k !== "id" &&
        k !== "createdAt" &&
        k !== "updatedAt",
    ),
  ]);

  allProfileFields.forEach((field) => {
    const key = field as keyof Profile;
    const localMod = localProfileFields[field] ?? 0;
    const remoteMod = remoteProfileFields[field] ?? 0;
    const localVal = localProfile[key];
    const remoteVal = remoteProfile[key];

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
    } else if (remoteMod > localMod) {
      // Remote is newer, update merged data
      // Use 'any' cast for dynamic property assignment, disabling ESLint for this line
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mergedData.profile as any)[key] = remoteVal;
      if (!mergedData.profile._fieldsModified)
        mergedData.profile._fieldsModified = {};
      mergedData.profile._fieldsModified[field] = remoteMod;
    }
    // If local is newer or times are equal, keep local (already in mergedData)
    // Ensure timestamp is updated if remote was newer but value was same
    if (remoteMod > localMod && !mergedData.profile._fieldsModified?.[field]) {
      if (!mergedData.profile._fieldsModified)
        mergedData.profile._fieldsModified = {};
      mergedData.profile._fieldsModified[field] = remoteMod;
    } else if (
      localMod >= remoteMod &&
      !mergedData.profile._fieldsModified?.[field]
    ) {
      if (!mergedData.profile._fieldsModified)
        mergedData.profile._fieldsModified = {};
      mergedData.profile._fieldsModified[field] = localMod;
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
    `${item.pageIndex}-${item.padIndex}`;
  const padConfigResult = compareSyncableArrays(
    // Let type inference work
    localData.padConfigurations,
    remoteData.padConfigurations ?? [],
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
  const pageMetaKeyExtractor = (item: PageMetadata) =>
    item.pageIndex.toString();
  const pageMetaResult = compareSyncableArrays(
    // Let type inference work
    localData.pageMetadata,
    remoteData.pageMetadata ?? [],
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

  // --- Final Merge Metadata ---
  // Set the timestamp for the *merged* data before returning/uploading
  mergedData._lastSyncTimestamp = Date.now();

  console.log(
    `Conflict detection complete. Found ${conflicts.length} conflicts. Requires manual resolution: ${requiresManualResolution}`,
  );
  return { conflicts, requiresManualResolution, mergedData };
};
