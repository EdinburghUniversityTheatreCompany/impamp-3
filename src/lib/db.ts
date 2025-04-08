import { openDB, DBSchema, IDBPDatabase } from 'idb';

const DB_NAME = 'ImpAmp2DB';
const DB_VERSION = 1;

// Define the structure of audio file data
export interface AudioFile {
  id?: number; // Auto-incrementing primary key
  blob: Blob;
  name: string;
  type: string;
  createdAt: Date;
}

// Define the structure of profile data
export type SyncType = 'local' | 'googleDrive';
export interface Profile {
  id?: number; // Auto-incrementing primary key
  name: string;
  syncType: SyncType;
  googleDriveFolderId?: string;
  lastSyncedEtag?: string; // ETag for profile.json in Drive
  createdAt: Date;
  updatedAt: Date;
}

// Define the structure of pad configuration data
export interface PadConfiguration {
  id?: number; // Auto-incrementing primary key
  profileId: number; // Foreign key to Profiles store
  padIndex: number; // 0-based index on the grid page (e.g., 0-31 for 4x8 grid)
  pageIndex: number; // 0-based index for the page within the profile
  keyBinding?: string;
  name?: string;
  audioFileId?: number; // Foreign key to AudioFiles store
  createdAt: Date;
  updatedAt: Date;
}

// Define the database schema using DBSchema
interface ImpAmpDBSchema extends DBSchema {
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
}

// Detect if we're running on the client side (browser) or server side
const isClient = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

// Singleton promise for the database connection
let dbPromise: Promise<IDBPDatabase<ImpAmpDBSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<ImpAmpDBSchema>> {
  // Return a fake promise if we're on the server to prevent errors
  if (!isClient) {
    console.warn('Attempted to access IndexedDB on the server. This is not supported.');
    return Promise.reject(new Error('IndexedDB is not available in this environment'));
  }

  if (!dbPromise) {
    dbPromise = openDB<ImpAmpDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);

        // Create audioFiles store
        if (!db.objectStoreNames.contains('audioFiles')) {
          const audioStore = db.createObjectStore('audioFiles', {
            keyPath: 'id',
            autoIncrement: true,
          });
          audioStore.createIndex('name', 'name');
          console.log('Created audioFiles object store');
        }

        // Create profiles store
        if (!db.objectStoreNames.contains('profiles')) {
          const profileStore = db.createObjectStore('profiles', {
            keyPath: 'id',
            autoIncrement: true,
          });
          profileStore.createIndex('name', 'name', { unique: true });
          console.log('Created profiles object store');
        }

        // Create padConfigurations store
        if (!db.objectStoreNames.contains('padConfigurations')) {
          const padConfigStore = db.createObjectStore('padConfigurations', {
            keyPath: 'id',
            autoIncrement: true,
          });
          // Index to quickly find all pads for a specific profile
          padConfigStore.createIndex('profileId', 'profileId');
          // Compound index to quickly find a specific pad on a specific page for a profile
          padConfigStore.createIndex('profilePagePad', [
            'profileId',
            'pageIndex',
            'padIndex',
          ], { unique: true });
          console.log('Created padConfigurations object store');
        }

        // --- Data seeding/migration can happen here ---
        // Example: Ensure a default profile exists after initial creation
        if (oldVersion < 1) {
            // Use transaction from upgrade callback
            const profileStore = transaction.objectStore('profiles');
            profileStore.count().then(count => {
                if (count === 0) {
                    console.log('Adding default local profile...');
                    profileStore.add({
                        name: 'Default Local Profile',
                        syncType: 'local',
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    }).catch(err => console.error("Error adding default profile:", err));
                }
            }).catch(err => console.error("Error counting profiles:", err));
        }
      },
      blocked() {
        console.error('IndexedDB blocked. Please close other tabs using this database.');
        // Potentially show a notification to the user
      },
      blocking() {
        console.warn('IndexedDB blocking. Database version change pending.');
        // db.close(); // Close the connection if necessary
      },
      terminated() {
        console.error('IndexedDB connection terminated unexpectedly.');
        dbPromise = null; // Reset promise to allow reconnection attempt
      },
    });
  }
  return dbPromise;
}

// --- Basic CRUD Operations ---

// Example: Add an audio file
export async function addAudioFile(audioFile: Omit<AudioFile, 'id' | 'createdAt'>): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('audioFiles', 'readwrite');
  const store = tx.objectStore('audioFiles');
  const id = await store.add({ ...audioFile, createdAt: new Date() });
  await tx.done;
  console.log(`Added audio file with id: ${id}`);
  return id;
}

// Example: Get an audio file by ID
export async function getAudioFile(id: number): Promise<AudioFile | undefined> {
  const db = await getDb();
  return db.get('audioFiles', id);
}

// Example: Add a profile
export async function addProfile(profile: Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const db = await getDb();
    const tx = db.transaction('profiles', 'readwrite');
    const store = tx.objectStore('profiles');
    const now = new Date();
    try {
        const id = await store.add({ ...profile, createdAt: now, updatedAt: now });
        await tx.done;
        console.log(`Added profile with id: ${id}`);
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

// Example: Get all profiles
export async function getAllProfiles(): Promise<Profile[]> {
    const db = await getDb();
    return db.getAll('profiles');
}

// Example: Add or update a pad configuration
export async function upsertPadConfiguration(padConfig: Omit<PadConfiguration, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const db = await getDb();
    const tx = db.transaction('padConfigurations', 'readwrite');
    const store = tx.objectStore('padConfigurations');
    const index = store.index('profilePagePad');
    const now = new Date();

    // Check if a configuration already exists for this profile/page/pad combination
    const existing = await index.get([padConfig.profileId, padConfig.pageIndex, padConfig.padIndex]);

    let id: number;
    if (existing?.id) {
        // Update existing
        id = existing.id;
        await store.put({ ...existing, ...padConfig, updatedAt: now });
        console.log(`Updated pad configuration with id: ${id}`);
    } else {
        // Add new
        id = await store.add({ ...padConfig, createdAt: now, updatedAt: now });
        console.log(`Added pad configuration with id: ${id}`);
    }

    await tx.done;
    return id;
}

// Example: Get all pad configurations for a specific profile and page
export async function getPadConfigurationsForProfilePage(profileId: number, pageIndex: number): Promise<PadConfiguration[]> {
    const db = await getDb();
    const tx = db.transaction('padConfigurations', 'readonly');
    const store = tx.objectStore('padConfigurations');
    const index = store.index('profilePagePad');
    // Use a range query on the compound index
    const range = IDBKeyRange.bound(
        [profileId, pageIndex, -Infinity], // Lower bound (start of the page)
        [profileId, pageIndex, Infinity]  // Upper bound (end of the page)
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
            await addProfile({
                name: 'Default Local Profile',
                syncType: 'local',
            });
            console.log("Default profile added successfully.");
        } else {
            console.log("Profiles already exist.");
        }
    } catch (error) {
        console.error("Error ensuring default profile:", error);
    }
}

// Only initialize the database on the client side
if (isClient) {
  // Call getDb() early to initiate the connection and upgrade process
  getDb().catch(console.error);
}
