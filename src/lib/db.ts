import { openDB, DBSchema, IDBPDatabase } from "idb";

const DB_NAME = "impamp3DB";
const DB_VERSION = 3;

// Define the structure of audio file data
export interface AudioFile {
  id?: number; // Auto-incrementing primary key
  blob: Blob;
  name: string;
  type: string;
  createdAt: Date;
}

// Define the structure of profile data
export type SyncType = "local" | "googleDrive";
export interface Profile {
  id?: number; // Auto-incrementing primary key
  name: string;
  syncType: SyncType;
  googleDriveFolderId?: string;
  lastSyncedEtag?: string; // ETag for profile.json in Drive
  activePadBehavior?: ActivePadBehavior; // How to handle activating an already active pad
  lastBackedUpAt: number; // Timestamp (ms) of the last successful backup/export
  backupReminderPeriod: number; // Duration (ms) after which to remind, -1 for never
  createdAt: Date;
  updatedAt: Date;
}

// Define the possible behaviors for activating an already active pad
export type ActivePadBehavior = "continue" | "stop" | "restart";

// Define the playback types for multi-sound pads
export type PlaybackType = "sequential" | "random" | "round-robin";

// Define the structure of pad configuration data
export interface PadConfiguration {
  id?: number; // Auto-incrementing primary key
  profileId: number; // Foreign key to Profiles store
  padIndex: number; // 0-based index on the grid page (e.g., 0-31 for 4x8 grid)
  pageIndex: number; // 0-based index for the page within the profile
  keyBinding?: string;
  name?: string;
  // audioFileId?: number; // DEPRECATED: Replaced by audioFileIds
  audioFileIds: number[]; // Array of foreign keys to AudioFiles store
  playbackType: PlaybackType; // How to play multiple sounds
  createdAt: Date;
  updatedAt: Date;
}

// Define the structure of page/bank metadata
export interface PageMetadata {
  id?: number; // Auto-incrementing primary key
  profileId: number; // Foreign key to Profiles store
  pageIndex: number; // 0-based index for the page
  name: string; // Name of the bank/page
  isEmergency: boolean; // Whether this is an emergency bank
  createdAt: Date;
  updatedAt: Date;
}

// Define the database schema using DBSchema
export interface ImpAmpDBSchema extends DBSchema {
  audioFiles: {
    key: number;
    value: AudioFile;
    indexes: { name: string };
  };
  profiles: {
    key: number;
    value: Profile;
    indexes: { name: string };
  };
  padConfigurations: {
    key: number;
    value: PadConfiguration;
    indexes: { profileId: number; profilePagePad: [number, number, number] }; // Index for profileId, and compound index for profile/page/pad
  };
  pageMetadata: {
    key: number;
    value: PageMetadata;
    indexes: { profileId: number; profilePage: [number, number] }; // Index for profileId, and compound index for profile+page
  };
}

// Detect if we're running on the client side (browser) or server side
const isClient =
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";

// Default backup reminder period (30 days in milliseconds)
export const DEFAULT_BACKUP_REMINDER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // Export this constant

// Singleton promise for the database connection
let dbPromise: Promise<IDBPDatabase<ImpAmpDBSchema>> | null = null;

export function getDb(): Promise<IDBPDatabase<ImpAmpDBSchema>> {
  // Added export
  // Return a fake promise if we're on the server to prevent errors
  if (!isClient) {
    console.warn(
      "Attempted to access IndexedDB on the server. This is not supported.",
    );
    return Promise.reject(
      new Error("IndexedDB is not available in this environment"),
    );
  }

  if (!dbPromise) {
    dbPromise = openDB<ImpAmpDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        // Removed unused event param
        console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);

        // --- Version 1 Stores ---
        // Create audioFiles store
        if (!db.objectStoreNames.contains("audioFiles")) {
          const audioStore = db.createObjectStore("audioFiles", {
            keyPath: "id",
            autoIncrement: true,
          });
          audioStore.createIndex("name", "name");
          console.log("Created audioFiles object store");
        }

        // Create profiles store
        if (!db.objectStoreNames.contains("profiles")) {
          const profileStore = db.createObjectStore("profiles", {
            keyPath: "id",
            autoIncrement: true,
          });
          profileStore.createIndex("name", "name", { unique: true });
          console.log("Created profiles object store");
        }

        // Create padConfigurations store
        if (!db.objectStoreNames.contains("padConfigurations")) {
          const padConfigStore = db.createObjectStore("padConfigurations", {
            keyPath: "id",
            autoIncrement: true,
          });
          // Index to quickly find all pads for a specific profile
          padConfigStore.createIndex("profileId", "profileId");
          // Compound index to quickly find a specific pad on a specific page for a profile
          padConfigStore.createIndex(
            "profilePagePad",
            ["profileId", "pageIndex", "padIndex"],
            { unique: true },
          );
          console.log("Created padConfigurations object store");
        }

        // --- Version 2 Store ---
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("pageMetadata")) {
            const pageMetadataStore = db.createObjectStore("pageMetadata", {
              keyPath: "id",
              autoIncrement: true,
            });
            // Index to quickly find all pages for a specific profile
            pageMetadataStore.createIndex("profileId", "profileId");
            // Compound index to quickly find metadata for a specific page in a profile
            pageMetadataStore.createIndex(
              "profilePage",
              ["profileId", "pageIndex"],
              { unique: true },
            );
            console.log("Created pageMetadata object store");
          }
        }

        // --- Version 3 Migration (Multi-Sound Pads) ---
        if (oldVersion < 3) {
          console.log(
            "Applying V3 migration: Updating padConfigurations for multi-sound...",
          );
          if (!transaction) {
            console.error("V3 Migration Error: Transaction object is null!");
            // Attempt to get a new transaction if possible, though this is unusual in upgrade
            // transaction = db.transaction('padConfigurations', 'readwrite');
            // If still null, we might have to abort or throw
            throw new Error(
              "Cannot perform V3 migration without a transaction.",
            );
          }
          const store = transaction.objectStore("padConfigurations");
          // Use cursor to iterate and update each object
          store
            .openCursor()
            .then(function iterateCursor(cursor) {
              if (!cursor) {
                console.log(
                  "V3 Migration: Finished iterating padConfigurations.",
                );
                return;
              }
              // Access potentially old field dynamically to avoid strict type errors
              const oldConfigValue = cursor.value as PadConfiguration & {
                audioFileId?: number;
              };
              const audioFileIds: number[] = [];
              if (
                oldConfigValue.audioFileId !== undefined &&
                oldConfigValue.audioFileId !== null &&
                typeof oldConfigValue.audioFileId === "number"
              ) {
                audioFileIds.push(oldConfigValue.audioFileId);
              }

              // Construct the new config object carefully, excluding the old field
              const newConfig: PadConfiguration = {
                id: oldConfigValue.id,
                profileId: oldConfigValue.profileId,
                padIndex: oldConfigValue.padIndex,
                pageIndex: oldConfigValue.pageIndex,
                keyBinding: oldConfigValue.keyBinding,
                name: oldConfigValue.name,
                audioFileIds: audioFileIds, // Set new array
                playbackType: "round-robin", // Default playback type for migrated pads
                createdAt: oldConfigValue.createdAt,
                updatedAt: oldConfigValue.updatedAt, // Keep original updatedAt during migration
              };

              // Update the record in the store
              cursor.update(newConfig);

              cursor.continue().then(iterateCursor); // Use .then for async iteration
            })
            .catch((err) => {
              console.error("V3 Migration Error during cursor iteration:", err);
              // Abort the transaction on error
              if (transaction) {
                transaction.abort();
              }
            });
        }

        // --- Data seeding/migration can happen here ---
        // Example: Ensure a default profile exists after initial creation
        if (oldVersion < 1) {
          // Use transaction from upgrade callback
          // Note: The duplicated pageMetadataStore creation was removed.
          // The default profile seeding logic remains.
          const profileStore = transaction.objectStore("profiles");
          profileStore
            .count()
            .then((count) => {
              if (count === 0) {
                console.log("Adding default local profile...");
                // Define timestamp variables *before* adding
                const now = new Date();
                const nowMs = now.getTime();
                profileStore
                  .add({
                    name: "Default Local Profile",
                    syncType: "local",
                    lastBackedUpAt: nowMs, // Initialize to creation time
                    backupReminderPeriod: DEFAULT_BACKUP_REMINDER_PERIOD_MS, // Default reminder period
                    createdAt: now,
                    updatedAt: now,
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
        console.error(
          "IndexedDB blocked. Please close other tabs using this database.",
        );
        // Potentially show a notification to the user
      },
      blocking() {
        console.warn("IndexedDB blocking. Database version change pending.");
        // db.close(); // Close the connection if necessary
      },
      terminated() {
        console.error("IndexedDB connection terminated unexpectedly.");
        dbPromise = null; // Reset promise to allow reconnection attempt
      },
    });
  }
  return dbPromise;
}

// --- Basic CRUD Operations ---

// Example: Add an audio file
export async function addAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const store = tx.objectStore("audioFiles");
  const id = await store.add({ ...audioFile, createdAt: new Date() });
  await tx.done;
  console.log(`Added audio file with id: ${id}`);
  return id;
}

// Example: Get an audio file by ID
export async function getAudioFile(id: number): Promise<AudioFile | undefined> {
  const db = await getDb();
  return db.get("audioFiles", id);
}

// Add a profile
export async function addProfile(
  profile: Omit<Profile, "id" | "createdAt" | "updatedAt">,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("profiles", "readwrite");
  const store = tx.objectStore("profiles");
  const now = new Date();
  const nowMs = now.getTime();
  try {
    const id = await store.add({
      ...profile,
      lastBackedUpAt: nowMs, // Initialize to creation time
      backupReminderPeriod: DEFAULT_BACKUP_REMINDER_PERIOD_MS, // Default reminder period
      createdAt: now,
      updatedAt: now,
    });
    await tx.done;
    // Log the newly added profile details including backup fields
    console.log(
      `[DB] Added profile: ID=${id}, Name="${profile.name}", SyncType=${profile.syncType}, LastBackedUpAt=${nowMs}, BackupReminderPeriod=${DEFAULT_BACKUP_REMINDER_PERIOD_MS}`,
    );
    return id;
  } catch (error) {
    console.error("Failed to add profile:", error);
    // Handle specific errors like constraint errors if needed
    if (tx.error) {
      console.error("Transaction error:", tx.error);
    }
    throw error; // Re-throw the error
  }
}

// Get a profile by ID
export async function getProfile(id: number): Promise<Profile | undefined> {
  const db = await getDb();
  return db.get("profiles", id);
}

// Update a profile
export async function updateProfile(
  id: number,
  updates: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">>,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("profiles", "readwrite");
  const store = tx.objectStore("profiles");

  try {
    // Get the existing profile
    const existingProfile = await store.get(id);
    if (!existingProfile) {
      throw new Error(`Profile with id ${id} not found`);
    }

    // Update the profile
    const updatedProfile = {
      ...existingProfile,
      ...updates,
      updatedAt: new Date(),
    };

    // Log which specific fields are being updated, especially backup-related ones
    console.log(
      `[DB] Updating profile ID=${id}. Changes: ${Object.keys(updates).join(", ")}.`,
      updates.lastBackedUpAt !== undefined
        ? `New lastBackedUpAt: ${updates.lastBackedUpAt}`
        : "",
      updates.backupReminderPeriod !== undefined
        ? `New backupReminderPeriod: ${updates.backupReminderPeriod}`
        : "",
    );

    await store.put(updatedProfile);
    await tx.done;
    console.log(`[DB] Successfully updated profile with id: ${id}`);
  } catch (error) {
    console.error(`[DB] Failed to update profile ${id}:`, error);
    throw error;
  }
}

// Delete a profile
export async function deleteProfile(id: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ["profiles", "padConfigurations", "pageMetadata"],
    "readwrite",
  );

  try {
    // Delete the profile
    await tx.objectStore("profiles").delete(id);

    // Delete associated pad configurations
    const padStore = tx.objectStore("padConfigurations");
    const padIndex = padStore.index("profileId");
    let padCursor = await padIndex.openCursor(id);

    while (padCursor) {
      await padCursor.delete();
      padCursor = await padCursor.continue();
    }

    // Delete associated page metadata
    const pageStore = tx.objectStore("pageMetadata");
    const pageIndex = pageStore.index("profileId");
    let pageCursor = await pageIndex.openCursor(id);

    while (pageCursor) {
      await pageCursor.delete();
      pageCursor = await pageCursor.continue();
    }

    await tx.done;
    console.log(`Deleted profile with id: ${id} and all associated data`);
  } catch (error) {
    console.error(`Failed to delete profile ${id}:`, error);
    throw error;
  }
}

// Get all profiles
export async function getAllProfiles(): Promise<Profile[]> {
  const db = await getDb();
  return db.getAll("profiles");
}

// Add or update a pad configuration
export async function upsertPadConfiguration(
  padConfig: Omit<PadConfiguration, "id" | "createdAt" | "updatedAt">,
): Promise<number> {
  // Ensure required fields for the new structure are present
  if (!padConfig.audioFileIds || !padConfig.playbackType) {
    console.error(
      "Attempted to upsert PadConfiguration without audioFileIds or playbackType",
      padConfig,
    );
    throw new Error(
      "PadConfiguration must include audioFileIds and playbackType.",
    );
  }

  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readwrite");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profilePagePad");
  const now = new Date();

  try {
    // Check if a configuration already exists for this profile/page/pad combination
    const existing = await index.get([
      padConfig.profileId,
      padConfig.pageIndex,
      padConfig.padIndex, // Corrected: Use the correct compound key structure
    ]);

    let id: number; // Declare id outside the if/else block

    if (existing?.id) {
      // Update existing
      id = existing.id;
      // Construct update data ensuring correct type and no old field
      const updateData: PadConfiguration = {
        ...existing,
        ...padConfig,
        id: existing.id, // Ensure id is explicitly carried over
        updatedAt: now,
      };
      // No need to delete audioFileId as padConfig shouldn't have it, and spread overwrites
      await store.put(updateData);
      console.log(`Updated pad configuration with id: ${id}`, updateData);
    } else {
      // Add new
      // Construct add data ensuring correct type and no old field
      const addData: Omit<PadConfiguration, "id"> = {
        ...padConfig,
        createdAt: now,
        updatedAt: now,
      };
      // No need to delete audioFileId as padConfig shouldn't have it
      id = await store.add(addData);
      console.log(`Added pad configuration with id: ${id}`, addData);
    }

    await tx.done;
    return id; // Now id is accessible here
  } catch (error) {
    console.error("Error in upsertPadConfiguration:", error);
    if (tx.error) {
      console.error("Transaction error:", tx.error);
    }
    // Attempt to abort the transaction on error
    try {
      if (!tx.done) {
        // Check if transaction is already finished
        tx.abort();
        console.log(
          "Transaction aborted due to error in upsertPadConfiguration.",
        );
      }
    } catch (abortError) {
      console.error("Error aborting transaction:", abortError);
    }
    throw error; // Re-throw the original error
  }
  // This part is unreachable due to try/catch but kept for structure if needed later
  // await tx.done;
  // return id; // This return is now handled within the try block
}

// Example: Get all pad configurations for a specific profile and page
export async function getPadConfigurationsForProfilePage(
  profileId: number,
  pageIndex: number,
): Promise<PadConfiguration[]> {
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readonly");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profilePagePad");
  // Use a range query on the compound index
  const range = IDBKeyRange.bound(
    [profileId, pageIndex, -Infinity], // Lower bound (start of the page)
    [profileId, pageIndex, Infinity], // Upper bound (end of the page)
  );
  return index.getAll(range);
}

// Ensure the default profile exists on app load (call this somewhere central)
export async function ensureDefaultProfile() {
  try {
    await getDb(); // Ensure DB is open and upgraded
    const profiles = await getAllProfiles();
    if (profiles.length === 0) {
      console.log("No profiles found, attempting to add default...");
      console.log("Adding default profile with backup fields...");
      const now = new Date();
      const nowMs = now.getTime();
      await addProfile({
        name: "Default Local Profile",
        syncType: "local",
        // Explicitly set backup fields for clarity, though addProfile handles defaults
        lastBackedUpAt: nowMs,
        backupReminderPeriod: DEFAULT_BACKUP_REMINDER_PERIOD_MS,
      });
      console.log("Default profile added successfully.");
    } else {
      console.log("Profiles already exist.");
    }
  } catch (error) {
    console.error("Error ensuring default profile:", error);
  }
}

// Function to get page metadata for a specific profile and page
export async function getPageMetadata(
  profileId: number,
  pageIndex: number,
): Promise<PageMetadata | undefined> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readonly");
  const store = tx.objectStore("pageMetadata");
  const index = store.index("profilePage");
  // Use get with the compound index
  return index.get([profileId, pageIndex]);
}

// Function to get all page metadata for a specific profile
export async function getAllPageMetadataForProfile(
  profileId: number,
): Promise<PageMetadata[]> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readonly");
  const store = tx.objectStore("pageMetadata");
  const index = store.index("profileId");
  return index.getAll(profileId);
}

// Function to add or update page metadata
export async function upsertPageMetadata(
  pageMetadata: Omit<PageMetadata, "id" | "createdAt" | "updatedAt">,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const index = store.index("profilePage");
  const now = new Date();

  // Check if metadata already exists for this profile/page combination
  const existing = await index.get([
    pageMetadata.profileId,
    pageMetadata.pageIndex,
  ]);

  let id: number;
  if (existing?.id) {
    // Update existing
    id = existing.id;
    await store.put({ ...existing, ...pageMetadata, updatedAt: now });
    console.log(`Updated page metadata with id: ${id}`);
  } else {
    // Add new
    id = await store.add({ ...pageMetadata, createdAt: now, updatedAt: now });
    console.log(`Added page metadata with id: ${id}`);
  }

  await tx.done;
  return id;
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

// Helper function to rename a page
export async function renamePage(
  profileId: number,
  pageIndex: number,
  newName: string,
): Promise<void> {
  try {
    const metadata = await getPageMetadata(profileId, pageIndex);

    await upsertPageMetadata({
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

// Helper function to set emergency state for a page
export async function setPageEmergencyState(
  profileId: number,
  pageIndex: number,
  isEmergency: boolean,
): Promise<void> {
  try {
    const metadata = await getPageMetadata(profileId, pageIndex);

    // Check the current state to see if it's actually changing
    await upsertPageMetadata({
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
  // Call getDb() early to initiate the connection and upgrade process
  getDb().catch(console.error);
}
