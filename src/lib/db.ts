import { openDB, DBSchema, IDBPDatabase, IDBPTransaction } from "idb";

const DB_NAME = "impamp3DB";
const DB_VERSION = 4; // DB version for sync fields

// Define the structure of audio file data
export interface AudioFile {
  id?: number;
  blob: Blob;
  name: string;
  type: string;
  createdAt: Date;
}

// Define the structure of profile data
export type SyncType = "local" | "googleDrive";
export interface Profile {
  id?: number;
  name: string;
  syncType: SyncType;
  googleDriveFileId?: string | null; // Link to the specific file in user's Drive
  activePadBehavior?: ActivePadBehavior;
  syncPausedUntil?: number; // Timestamp when sync should resume (null/undefined if not paused)
  lastBackedUpAt: number;
  backupReminderPeriod: number;
  createdAt: Date;
  updatedAt: Date;
  // Sync Timestamps
  _created?: number;
  _modified?: number;
  _fieldsModified?: Record<string, number>;
}

export type ActivePadBehavior = "continue" | "stop" | "restart";
export type PlaybackType = "sequential" | "random" | "round-robin";

// Define the structure of pad configuration data
export interface PadConfiguration {
  id?: number;
  profileId: number;
  padIndex: number;
  pageIndex: number;
  keyBinding?: string;
  name?: string;
  audioFileIds: number[];
  playbackType: PlaybackType;
  createdAt: Date;
  updatedAt: Date;
  // Sync Timestamps
  _created?: number;
  _modified?: number;
  _fieldsModified?: Record<string, number>;
}

// Define the structure of page/bank metadata
export interface PageMetadata {
  id?: number;
  profileId: number;
  pageIndex: number;
  name: string;
  isEmergency: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Sync Timestamps
  _created?: number;
  _modified?: number;
  _fieldsModified?: Record<string, number>;
}

// Define the database schema
export interface ImpAmpDBSchema extends DBSchema {
  audioFiles: { key: number; value: AudioFile; indexes: { name: string } };
  profiles: { key: number; value: Profile; indexes: { name: string } };
  padConfigurations: {
    key: number;
    value: PadConfiguration;
    indexes: { profileId: number; profilePagePad: [number, number, number] };
  };
  pageMetadata: {
    key: number;
    value: PageMetadata;
    indexes: { profileId: number; profilePage: [number, number] };
  };
}

const isClient =
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
export const DEFAULT_BACKUP_REMINDER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
let dbPromise: Promise<IDBPDatabase<ImpAmpDBSchema>> | null = null;

// Helper function to iterate and update records within an upgrade transaction
// We need to use a generic transaction type to handle the versionchange transaction
const migrateStoreV4 = (
  transaction: IDBPTransaction<
    ImpAmpDBSchema,
    Array<"profiles" | "audioFiles" | "padConfigurations" | "pageMetadata">,
    "versionchange"
  >,
  storeName: "profiles" | "padConfigurations" | "pageMetadata",
) => {
  console.log(`V4 Migration: Starting update for store "${storeName}"...`);
  const store = transaction.objectStore(storeName);
  return store.openCursor().then(function iterateCursor(cursor): Promise<void> {
    if (!cursor) {
      console.log(`V4 Migration: Finished iterating ${storeName}.`);
      return Promise.resolve();
    }
    const record = cursor.value;
    const now = Date.now();
    const createdAtMs =
      record.createdAt instanceof Date ? record.createdAt.getTime() : now;
    const updatedAtMs =
      record.updatedAt instanceof Date ? record.updatedAt.getTime() : now;

    // Create a copy of the record with our basic modifications
    const updateData = {
      ...record,
      _created: record._created ?? createdAtMs,
      _modified: record._modified ?? updatedAtMs,
      _fieldsModified: record._fieldsModified ?? {},
    };

    // Handle profile-specific fields if this is a profile record
    if (storeName === "profiles") {
      const profileRecord = record as Profile;
      const profileUpdateData = updateData as Partial<Profile> &
        typeof updateData;
      profileUpdateData.googleDriveFileId =
        profileRecord.googleDriveFileId ?? null;

      // Use a Record type with index signature instead of any
      const recordUpdateData = updateData as Record<string, unknown>;
      if ("googleDriveFolderId" in recordUpdateData) {
        delete recordUpdateData.googleDriveFolderId;
      }
      if ("lastSyncedEtag" in recordUpdateData) {
        delete recordUpdateData.lastSyncedEtag;
      }
    }

    // Type assertion for the final update based on the store
    if (storeName === "profiles") {
      const finalData = updateData as Profile;
      return cursor
        .update(finalData)
        .then(() => cursor.continue())
        .then(iterateCursor)
        .catch((updateError) => {
          console.error(
            `V4 Migration: Error updating record in ${storeName} with key ${cursor.key}:`,
            updateError,
          );
          return cursor.continue().then(iterateCursor);
        });
    } else if (storeName === "padConfigurations") {
      const finalData = updateData as PadConfiguration;
      return cursor
        .update(finalData)
        .then(() => cursor.continue())
        .then(iterateCursor)
        .catch((updateError) => {
          console.error(
            `V4 Migration: Error updating record in ${storeName} with key ${cursor.key}:`,
            updateError,
          );
          return cursor.continue().then(iterateCursor);
        });
    } else {
      const finalData = updateData as PageMetadata;
      return cursor
        .update(finalData)
        .then(() => cursor.continue())
        .then(iterateCursor)
        .catch((updateError) => {
          console.error(
            `V4 Migration: Error updating record in ${storeName} with key ${cursor.key}:`,
            updateError,
          );
          return cursor.continue().then(iterateCursor);
        });
    }
  });
};

export function getDb(): Promise<IDBPDatabase<ImpAmpDBSchema>> {
  if (!isClient) {
    console.warn("Attempted to access IndexedDB on the server.");
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  if (!dbPromise) {
    dbPromise = openDB<ImpAmpDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        // Removed unused event
        console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);

        // V1 Stores
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains("audioFiles")) {
            db.createObjectStore("audioFiles", {
              keyPath: "id",
              autoIncrement: true,
            }).createIndex("name", "name");
          }
          if (!db.objectStoreNames.contains("profiles")) {
            db.createObjectStore("profiles", {
              keyPath: "id",
              autoIncrement: true,
            }).createIndex("name", "name", { unique: true });
          }
          if (!db.objectStoreNames.contains("padConfigurations")) {
            const store = db.createObjectStore("padConfigurations", {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("profileId", "profileId");
            store.createIndex(
              "profilePagePad",
              ["profileId", "pageIndex", "padIndex"],
              { unique: true },
            );
          }
        }
        // V2 Store
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("pageMetadata")) {
            const store = db.createObjectStore("pageMetadata", {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("profileId", "profileId");
            store.createIndex("profilePage", ["profileId", "pageIndex"], {
              unique: true,
            });
          }
        }
        // V3 Migration
        if (oldVersion < 3) {
          console.log("Applying V3 migration...");
          if (!transaction) {
            throw new Error("V3 Migration: No transaction");
          }
          const store = transaction.objectStore("padConfigurations");
          store
            .openCursor()
            .then(function iterateV3(cursor) {
              if (!cursor) {
                console.log("V3 Migration complete.");
                return;
              }
              // First cast to unknown, then to Record to avoid type errors
              const oldVal = cursor.value as unknown as Record<string, unknown>;
              const audioFileIds =
                oldVal.audioFileId !== undefined && oldVal.audioFileId !== null
                  ? [oldVal.audioFileId as number]
                  : [];
              const newVal: PadConfiguration = {
                ...(oldVal as unknown as PadConfiguration),
                audioFileIds,
                playbackType: "round-robin",
              };
              // Use a Record type with index signature instead of any
              const newValRecord = newVal as unknown as Record<string, unknown>;
              if ("audioFileId" in newValRecord) {
                delete newValRecord.audioFileId;
              }
              cursor.update(newVal);
              cursor.continue().then(iterateV3);
            })
            .catch((err) => {
              console.error("V3 Migration Error:", err);
              transaction.abort();
            });
        }
        // V4 Migration
        if (oldVersion < 4) {
          console.log("Applying V4 migration...");
          if (!transaction) {
            throw new Error("V4 Migration: No transaction");
          }
          transaction.done.catch((err) => {
            console.error("Transaction failed during V4 migration:", err);
          });
          // Queue migrations (don't await directly in upgrade)
          migrateStoreV4(transaction, "profiles").catch(console.error);
          migrateStoreV4(transaction, "padConfigurations").catch(console.error);
          migrateStoreV4(transaction, "pageMetadata").catch(console.error);
          console.log("V4 Migration queued.");
        }

        // V1 Seeding (Default Profile)
        if (oldVersion < 1) {
          if (!transaction) {
            throw new Error("Cannot seed default profile without transaction.");
          }
          const profileStore = transaction.objectStore("profiles");
          profileStore
            .count()
            .then((count) => {
              if (count === 0) {
                console.log("Adding default local profile...");
                const now = new Date();
                const nowMs = now.getTime();
                profileStore
                  .add({
                    name: "Default Local Profile",
                    syncType: "local",
                    lastBackedUpAt: nowMs,
                    backupReminderPeriod: DEFAULT_BACKUP_REMINDER_PERIOD_MS,
                    createdAt: now,
                    updatedAt: now,
                    _created: nowMs,
                    _modified: nowMs,
                    _fieldsModified: {},
                    googleDriveFileId: null,
                  })
                  .catch((err: Error) =>
                    console.error("Error adding default profile:", err),
                  );
              }
            })
            .catch((err) => console.error("Error counting profiles:", err));
        }
      },
      blocked() {
        console.error("IndexedDB blocked.");
      },
      blocking() {
        console.warn("IndexedDB blocking.");
      },
      terminated() {
        console.error("IndexedDB terminated.");
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// --- Basic CRUD Operations (Updated for Sync Fields) ---

// Helper to generate sync fields for new/updated records
const generateSyncFields = (existingRecord?: {
  _created?: number;
}): { _created: number; _modified: number } => {
  const now = Date.now();
  return { _created: existingRecord?._created ?? now, _modified: now };
};

// Helper to update _fieldsModified based on changes
// Use generic type parameter with no constraints
const updateFieldsModified = <T>(
  newData: Partial<T>,
  existingRecord: T,
  fieldsModified: Record<string, number> | undefined,
): Record<string, number> => {
  const now = Date.now();
  const updatedFields = { ...(fieldsModified ?? {}) };
  for (const key in newData) {
    if (Object.prototype.hasOwnProperty.call(newData, key)) {
      if (
        !key.startsWith("_") &&
        key !== "id" &&
        key !== "createdAt" &&
        key !== "updatedAt"
      ) {
        if (
          JSON.stringify(newData[key as keyof T]) !==
          JSON.stringify(existingRecord[key as keyof T])
        ) {
          updatedFields[key] = now;
        }
      }
    }
  }
  return updatedFields;
};

// Add an audio file
export async function addAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const id = await tx.store.add({ ...audioFile, createdAt: new Date() });
  await tx.done;
  console.log(`Added audio file with id: ${id}`);
  return id;
}

// Get an audio file by ID
export async function getAudioFile(id: number): Promise<AudioFile | undefined> {
  const db = await getDb();
  return db.get("audioFiles", id);
}

// Delete an audio file by ID
export async function deleteAudioFile(id: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  await tx.store.delete(id);
  await tx.done;
  console.log(`Deleted audio file with id: ${id}`);
}

// Get all audio file IDs referenced by pad configurations for a specific profile
export async function getAudioFileIdsForProfile(
  profileId: number,
): Promise<Set<number>> {
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readonly");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profileId");
  const padConfigs = await index.getAll(profileId);
  await tx.done;

  const audioFileIds = new Set<number>();
  padConfigs.forEach((pad) => {
    if (pad.audioFileIds && pad.audioFileIds.length > 0) {
      pad.audioFileIds.forEach((id) => audioFileIds.add(id));
    }
  });

  console.log(
    `Found ${audioFileIds.size} unique audio file IDs for profile ${profileId}`,
  );
  return audioFileIds;
}

// Find orphaned audio files that are not referenced by any pad configuration
export async function findOrphanedAudioFiles(): Promise<{
  orphanedIds: Set<number>;
  referencedIds: Set<number>;
  totalAudioFiles: number;
}> {
  const db = await getDb();

  // Get all audio file IDs
  const audioTx = db.transaction("audioFiles", "readonly");
  const audioStore = audioTx.objectStore("audioFiles");
  const allAudioFiles = await audioStore.getAllKeys();
  await audioTx.done;

  // Get all referenced audio file IDs from pad configurations
  const padTx = db.transaction("padConfigurations", "readonly");
  const padStore = padTx.objectStore("padConfigurations");
  const allPadConfigs = await padStore.getAll();
  await padTx.done;

  const referencedIds = new Set<number>();
  allPadConfigs.forEach((pad) => {
    if (pad.audioFileIds && pad.audioFileIds.length > 0) {
      pad.audioFileIds.forEach((id) => referencedIds.add(id));
    }
  });

  // Find orphaned IDs (exist in audioFiles but not referenced by any pad)
  const orphanedIds = new Set<number>();
  allAudioFiles.forEach((audioId) => {
    if (typeof audioId === "number" && !referencedIds.has(audioId)) {
      orphanedIds.add(audioId);
    }
  });

  console.log(
    `[Orphan Detection] Found ${orphanedIds.size} orphaned audio files out of ${allAudioFiles.length} total`,
  );
  console.log(
    `[Orphan Detection] Referenced files: ${referencedIds.size}, Orphaned files: ${orphanedIds.size}`,
  );

  return {
    orphanedIds,
    referencedIds,
    totalAudioFiles: allAudioFiles.length,
  };
}

// Clean up orphaned audio files and their cache entries
export async function cleanupOrphanedAudioFiles(): Promise<{
  deletedCount: number;
  cacheEntriesCleared: number;
  errors: string[];
}> {
  const db = await getDb();
  const errors: string[] = [];
  let deletedCount = 0;
  let cacheEntriesCleared = 0;

  try {
    // Find orphaned files
    const { orphanedIds } = await findOrphanedAudioFiles();

    if (orphanedIds.size === 0) {
      console.log("[Orphan Cleanup] No orphaned audio files found");
      return { deletedCount: 0, cacheEntriesCleared: 0, errors: [] };
    }

    console.log(
      `[Orphan Cleanup] Starting cleanup of ${orphanedIds.size} orphaned audio files...`,
    );

    // Delete orphaned audio files in a single transaction
    const audioTx = db.transaction("audioFiles", "readwrite");
    const audioStore = audioTx.objectStore("audioFiles");

    const deletePromises = Array.from(orphanedIds).map(async (audioId) => {
      try {
        await audioStore.delete(audioId);
        deletedCount++;
        console.log(`[Orphan Cleanup] Deleted audio file ID: ${audioId}`);
      } catch (error) {
        const errorMsg = `Failed to delete audio file ${audioId}: ${error instanceof Error ? error.message : error}`;
        errors.push(errorMsg);
        console.error(`[Orphan Cleanup] ${errorMsg}`);
      }
    });

    await Promise.all(deletePromises);
    await audioTx.done;

    // Clear cache entries for deleted audio files
    if (typeof window !== "undefined") {
      try {
        const { clearCachedAudioBuffer } = await import("./audio/cache");
        for (const audioId of orphanedIds) {
          if (clearCachedAudioBuffer(audioId)) {
            cacheEntriesCleared++;
          }
        }
      } catch (cacheError) {
        const errorMsg = `Failed to clear audio cache entries: ${cacheError instanceof Error ? cacheError.message : cacheError}`;
        errors.push(errorMsg);
        console.warn(`[Orphan Cleanup] ${errorMsg}`);
      }
    }

    console.log(
      `[Orphan Cleanup] Completed: ${deletedCount} files deleted, ${cacheEntriesCleared} cache entries cleared`,
    );
    if (errors.length > 0) {
      console.warn(
        `[Orphan Cleanup] Encountered ${errors.length} errors during cleanup`,
      );
    }

    return { deletedCount, cacheEntriesCleared, errors };
  } catch (error) {
    const errorMsg = `Critical error during orphan cleanup: ${error instanceof Error ? error.message : error}`;
    console.error(`[Orphan Cleanup] ${errorMsg}`);
    errors.push(errorMsg);
    return { deletedCount, cacheEntriesCleared, errors };
  }
}

// Add a profile (Updated)
export async function addProfile(
  profileData: Omit<
    Profile,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "_created"
    | "_modified"
    | "_fieldsModified"
    | "lastBackedUpAt"
    | "backupReminderPeriod"
  > & { backupReminderPeriod?: number },
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("profiles", "readwrite");
  const now = new Date();
  const nowMs = now.getTime();
  const syncFields = generateSyncFields();
  const initialFieldsModified: Record<string, number> = {};
  Object.keys(profileData).forEach((key) => {
    if (
      !key.startsWith("_") &&
      key !== "id" &&
      key !== "createdAt" &&
      key !== "updatedAt"
    ) {
      initialFieldsModified[key as keyof typeof profileData] = nowMs;
    }
  });

  const profileToAdd: Omit<Profile, "id"> = {
    ...profileData,
    lastBackedUpAt: nowMs,
    backupReminderPeriod:
      profileData.backupReminderPeriod ?? DEFAULT_BACKUP_REMINDER_PERIOD_MS,
    googleDriveFileId: profileData.googleDriveFileId ?? null,
    createdAt: now,
    updatedAt: now,
    _created: syncFields._created,
    _modified: syncFields._modified,
    _fieldsModified: initialFieldsModified,
  };

  try {
    const id = await tx.store.add(profileToAdd);
    await tx.done;
    console.log(
      `[DB] Added profile: ID=${id}, Name="${profileToAdd.name}" with sync fields.`,
    );
    return id;
  } catch (error) {
    console.error("Failed to add profile:", error);
    if (tx.error) {
      console.error("Transaction error:", tx.error);
    }
    throw error;
  }
}

// Get a profile by ID
export async function getProfile(id: number): Promise<Profile | undefined> {
  const db = await getDb();
  return db.get("profiles", id);
}

// Update a profile (Updated)
export async function updateProfile(
  id: number,
  updates: Partial<
    Omit<
      Profile,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "_created"
      | "_modified"
      | "_fieldsModified"
    >
  >,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("profiles", "readwrite");
  try {
    const existingProfile = await tx.store.get(id);
    if (!existingProfile) {
      throw new Error(`Profile with id ${id} not found`);
    }

    const syncFields = generateSyncFields(existingProfile);
    const updatedFieldsModified = updateFieldsModified(
      updates,
      existingProfile,
      existingProfile._fieldsModified,
    );

    const updatedProfile: Profile = {
      ...existingProfile,
      ...updates,
      updatedAt: new Date(),
      _modified: syncFields._modified,
      _fieldsModified: updatedFieldsModified,
    };

    console.log(
      `[DB] Updating profile ID=${id}. Changes: ${Object.keys(updates).join(", ")}.`,
    );
    await tx.store.put(updatedProfile);
    await tx.done;
    console.log(`[DB] Successfully updated profile with id: ${id}`);
  } catch (error) {
    console.error(`[DB] Failed to update profile ${id}:`, error);
    if (tx.error && !tx.done) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

// Delete a profile
export async function deleteProfile(id: number): Promise<void> {
  const db = await getDb();

  // First, collect all audio file IDs referenced by this profile's pad configurations
  const audioFileIds = await getAudioFileIdsForProfile(id);

  const tx = db.transaction(
    ["profiles", "padConfigurations", "pageMetadata", "audioFiles"],
    "readwrite",
  );
  try {
    // Delete the profile
    await tx.objectStore("profiles").delete(id);

    // Delete pad configurations
    const padStore = tx.objectStore("padConfigurations");
    const padIndex = padStore.index("profileId");
    let padCursor = await padIndex.openCursor(id);
    while (padCursor) {
      await padCursor.delete();
      padCursor = await padCursor.continue();
    }

    // Delete page metadata
    const pageStore = tx.objectStore("pageMetadata");
    const pageIndex = pageStore.index("profileId");
    let pageCursor = await pageIndex.openCursor(id);
    while (pageCursor) {
      await pageCursor.delete();
      pageCursor = await pageCursor.continue();
    }

    // Delete associated audio files
    const audioStore = tx.objectStore("audioFiles");
    for (const audioFileId of audioFileIds) {
      await audioStore.delete(audioFileId);
    }

    await tx.done;

    // Clear audio cache entries for deleted audio files
    // Import dynamically to avoid circular dependency issues
    if (typeof window !== "undefined") {
      try {
        const { clearCachedAudioBuffer } = await import("./audio/cache");
        let clearedCacheCount = 0;
        for (const audioFileId of audioFileIds) {
          if (clearCachedAudioBuffer(audioFileId)) {
            clearedCacheCount++;
          }
        }
        console.log(
          `Deleted profile with id: ${id} and all associated data including ${audioFileIds.size} audio files (${clearedCacheCount} cache entries cleared)`,
        );
      } catch (cacheError) {
        console.warn("Failed to clear audio cache entries:", cacheError);
        console.log(
          `Deleted profile with id: ${id} and all associated data including ${audioFileIds.size} audio files`,
        );
      }
    } else {
      console.log(
        `Deleted profile with id: ${id} and all associated data including ${audioFileIds.size} audio files`,
      );
    }
  } catch (error) {
    console.error(`Failed to delete profile ${id}:`, error);
    if (tx.error && !tx.done) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

// Get all profiles
export async function getAllProfiles(): Promise<Profile[]> {
  const db = await getDb();
  return db.getAll("profiles");
}

// Add or update a pad configuration (Updated)
export async function upsertPadConfiguration(
  padConfig: Omit<
    PadConfiguration,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "_created"
    | "_modified"
    | "_fieldsModified"
  >,
): Promise<number> {
  if (!padConfig.audioFileIds || !padConfig.playbackType) {
    throw new Error(
      "PadConfiguration must include audioFileIds and playbackType.",
    );
  }
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readwrite");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profilePagePad");
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const existing = await index.get([
      padConfig.profileId,
      padConfig.pageIndex,
      padConfig.padIndex,
    ]);
    let id: number;

    if (existing?.id) {
      // Update
      id = existing.id;
      const syncFields = generateSyncFields(existing);
      const updatedFieldsModified = updateFieldsModified(
        padConfig,
        existing,
        existing._fieldsModified,
      );
      const finalData: PadConfiguration = {
        ...existing,
        ...padConfig,
        id: existing.id,
        updatedAt: now,
        _modified: syncFields._modified,
        _fieldsModified: updatedFieldsModified,
      };
      await store.put(finalData);
      console.log(`Updated pad configuration with id: ${id}`);
    } else {
      // Add new
      const syncFields = generateSyncFields();
      const initialFieldsModified: Record<string, number> = {};
      Object.keys(padConfig).forEach((key) => {
        if (
          !key.startsWith("_") &&
          key !== "id" &&
          key !== "createdAt" &&
          key !== "updatedAt"
        ) {
          initialFieldsModified[key as keyof typeof padConfig] = nowMs;
        }
      });
      const addData: Omit<PadConfiguration, "id"> = {
        ...padConfig,
        createdAt: now,
        updatedAt: now,
        _created: syncFields._created,
        _modified: syncFields._modified,
        _fieldsModified: initialFieldsModified,
      };
      id = await store.add(addData);
      console.log(`Added pad configuration with id: ${id}`);
    }
    await tx.done;
    return id;
  } catch (error) {
    console.error("Error in upsertPadConfiguration:", error);
    if (tx.error && !tx.done) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

// Get all pad configurations for a specific profile and page
export async function getPadConfigurationsForProfilePage(
  profileId: number,
  pageIndex: number,
): Promise<PadConfiguration[]> {
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readonly");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profilePagePad");
  const range = IDBKeyRange.bound(
    [profileId, pageIndex, -Infinity],
    [profileId, pageIndex, Infinity],
  );
  return index.getAll(range);
}

// Ensure the default profile exists on app load (Updated)
export async function ensureDefaultProfile() {
  try {
    await getDb(); // Ensure DB is open and upgraded
    const profiles = await getAllProfiles();
    if (profiles.length === 0) {
      console.log("No profiles found, attempting to add default...");
      await addProfile({ name: "Default Local Profile", syncType: "local" }); // Use updated addProfile
      console.log("Default profile added successfully.");
    } else {
      console.log("Profiles already exist.");
    }
  } catch (error) {
    console.error("Error ensuring default profile:", error);
  }
}

// Get page metadata for a specific profile and page
export async function getPageMetadata(
  profileId: number,
  pageIndex: number,
): Promise<PageMetadata | undefined> {
  const db = await getDb();
  return db.getFromIndex("pageMetadata", "profilePage", [profileId, pageIndex]);
}

// Function to get all page metadata for a specific profile
export async function getAllPageMetadataForProfile(
  profileId: number,
): Promise<PageMetadata[]> {
  const db = await getDb();
  return db.getAllFromIndex("pageMetadata", "profileId", profileId);
}

// Function to add or update page metadata (Updated)
export async function upsertPageMetadata(
  pageMetadata: Omit<
    PageMetadata,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "_created"
    | "_modified"
    | "_fieldsModified"
  >,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const index = store.index("profilePage");
  const now = new Date();
  const nowMs = now.getTime();

  try {
    const existing = await index.get([
      pageMetadata.profileId,
      pageMetadata.pageIndex,
    ]);
    let id: number;

    if (existing?.id) {
      // Update
      id = existing.id;
      const syncFields = generateSyncFields(existing);
      const updatedFieldsModified = updateFieldsModified(
        pageMetadata,
        existing,
        existing._fieldsModified,
      );
      const finalData: PageMetadata = {
        ...existing,
        ...pageMetadata,
        updatedAt: now,
        _modified: syncFields._modified,
        _fieldsModified: updatedFieldsModified,
      };
      await store.put(finalData);
      console.log(`Updated page metadata with id: ${id}`);
    } else {
      // Add new
      const syncFields = generateSyncFields();
      const initialFieldsModified: Record<string, number> = {};
      Object.keys(pageMetadata).forEach((key) => {
        if (
          !key.startsWith("_") &&
          key !== "id" &&
          key !== "createdAt" &&
          key !== "updatedAt"
        ) {
          initialFieldsModified[key as keyof typeof pageMetadata] = nowMs;
        }
      });
      const addData: Omit<PageMetadata, "id"> = {
        ...pageMetadata,
        createdAt: now,
        updatedAt: now,
        _created: syncFields._created,
        _modified: syncFields._modified,
        _fieldsModified: initialFieldsModified,
      };
      id = await store.add(addData);
      console.log(`Added page metadata with id: ${id}`);
    }
    await tx.done;
    return id;
  } catch (error) {
    console.error("Error in upsertPageMetadata:", error);
    if (tx.error && !tx.done) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

// Helper function to check if a page is marked as emergency
export async function isEmergencyPage(
  profileId: number,
  pageIndex: number,
): Promise<boolean> {
  try {
    const metadata = await getPageMetadata(profileId, pageIndex);
    return metadata?.isEmergency || false;
  } catch (error) {
    console.error(`Error checking if page ${pageIndex} is emergency:`, error);
    return false;
  }
}

// Helper function to rename a page (Updated)
export async function renamePage(
  profileId: number,
  pageIndex: number,
  newName: string,
): Promise<void> {
  try {
    const metadata = await getPageMetadata(profileId, pageIndex);
    await upsertPageMetadata({
      // upsert handles sync fields
      profileId,
      pageIndex,
      name: newName,
      isEmergency: metadata?.isEmergency || false,
    });
    console.log(`Renamed page ${pageIndex} to "${newName}"`);
  } catch (error) {
    console.error(`Error renaming page ${pageIndex}:`, error);
    throw error;
  }
}

// Helper function to set emergency state for a page (Updated)
export async function setPageEmergencyState(
  profileId: number,
  pageIndex: number,
  isEmergency: boolean,
): Promise<void> {
  try {
    const metadata = await getPageMetadata(profileId, pageIndex);
    await upsertPageMetadata({
      // upsert handles sync fields
      profileId,
      pageIndex,
      name: metadata?.name || `Bank ${pageIndex}`,
      isEmergency,
    });
    console.log(`Set emergency state for page ${pageIndex} to ${isEmergency}`);
  } catch (error) {
    console.error(
      `Error setting emergency state for page ${pageIndex}:`,
      error,
    );
    throw error;
  }
}

// Only initialize the database on the client side
if (isClient) {
  getDb().catch(console.error);
}
