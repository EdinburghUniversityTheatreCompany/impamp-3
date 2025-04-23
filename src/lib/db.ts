import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { useProfileStore } from '@/store/profileStore';
import { Impamp2Export } from './impamp2Types';
import { getPadIndexForKey } from './keyboardUtils';

const DB_NAME = 'impamp3DB';
const DB_VERSION = 2; // Bump version for schema upgrade

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
  pageMetadata: {
    key: number;
    value: PageMetadata;
    indexes: { profileId: number; profilePage: [number, number] }; // Index for profileId, and compound index for profile+page
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

        // Create pageMetadata store (in version 2)
        if (oldVersion < 2 && !db.objectStoreNames.contains('pageMetadata')) {
          const pageMetadataStore = db.createObjectStore('pageMetadata', {
            keyPath: 'id',
            autoIncrement: true,
          });
          // Index to quickly find all pages for a specific profile
          pageMetadataStore.createIndex('profileId', 'profileId');
          // Compound index to quickly find metadata for a specific page in a profile
          pageMetadataStore.createIndex('profilePage', [
            'profileId',
            'pageIndex',
          ], { unique: true });
          console.log('Created pageMetadata object store');
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

// Add a profile
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

// Get a profile by ID
export async function getProfile(id: number): Promise<Profile | undefined> {
    const db = await getDb();
    return db.get('profiles', id);
}

// Update a profile
export async function updateProfile(id: number, updates: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('profiles', 'readwrite');
    const store = tx.objectStore('profiles');
    
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
            updatedAt: new Date()
        };
        
        await store.put(updatedProfile);
        await tx.done;
        console.log(`Updated profile with id: ${id}`);
    } catch (error) {
        console.error(`Failed to update profile ${id}:`, error);
        throw error;
    }
}

// Delete a profile
export async function deleteProfile(id: number): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(['profiles', 'padConfigurations', 'pageMetadata'], 'readwrite');
    
    try {
        // Delete the profile
        await tx.objectStore('profiles').delete(id);
        
        // Delete associated pad configurations
        const padStore = tx.objectStore('padConfigurations');
        const padIndex = padStore.index('profileId');
        let padCursor = await padIndex.openCursor(id);
        
        while (padCursor) {
            await padCursor.delete();
            padCursor = await padCursor.continue();
        }
        
        // Delete associated page metadata
        const pageStore = tx.objectStore('pageMetadata');
        const pageIndex = pageStore.index('profileId');
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
    
    // After successfully updating the pad, check if it's on an emergency page
    // If so, increment the emergency sounds version to trigger a refresh
    try {
        const isOnEmergencyPage = await isEmergencyPage(padConfig.profileId, padConfig.pageIndex);
        if (isOnEmergencyPage) {
            // This pad is on an emergency page, so increment the version counter
            useProfileStore.getState().incrementEmergencySoundsVersion();
            console.log(`Updated pad on emergency page ${padConfig.pageIndex}, triggered emergency sounds refresh`);
        }
    } catch (error) {
        console.error("Error checking emergency page status:", error);
        // Continue even if this check fails - don't block the main operation
    }
    
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

// Function to get page metadata for a specific profile and page
export async function getPageMetadata(profileId: number, pageIndex: number): Promise<PageMetadata | undefined> {
    const db = await getDb();
    const tx = db.transaction('pageMetadata', 'readonly');
    const store = tx.objectStore('pageMetadata');
    const index = store.index('profilePage');
    // Use get with the compound index
    return index.get([profileId, pageIndex]);
}

// Function to get all page metadata for a specific profile
export async function getAllPageMetadataForProfile(profileId: number): Promise<PageMetadata[]> {
    const db = await getDb();
    const tx = db.transaction('pageMetadata', 'readonly');
    const store = tx.objectStore('pageMetadata');
    const index = store.index('profileId');
    return index.getAll(profileId);
}

// Function to add or update page metadata
export async function upsertPageMetadata(pageMetadata: Omit<PageMetadata, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const db = await getDb();
    const tx = db.transaction('pageMetadata', 'readwrite');
    const store = tx.objectStore('pageMetadata');
    const index = store.index('profilePage');
    const now = new Date();

    // Check if metadata already exists for this profile/page combination
    const existing = await index.get([pageMetadata.profileId, pageMetadata.pageIndex]);

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
export async function isEmergencyPage(profileId: number, pageIndex: number): Promise<boolean> {
    try {
        const metadata = await getPageMetadata(profileId, pageIndex);
        return metadata?.isEmergency || false;
    } catch (error) {
        console.error(`Error checking if page ${pageIndex} is emergency:`, error);
        return false;
    }
}

// Helper function to rename a page
export async function renamePage(profileId: number, pageIndex: number, newName: string): Promise<void> {
    try {
        const metadata = await getPageMetadata(profileId, pageIndex);
        
        await upsertPageMetadata({
            profileId,
            pageIndex,
            name: newName,
            isEmergency: metadata?.isEmergency || false
        });
        
        console.log(`Renamed page ${pageIndex} to "${newName}"`);
    } catch (error) {
        console.error(`Error renaming page ${pageIndex}:`, error);
        throw error;
    }
}

// Helper function to set emergency state for a page
export async function setPageEmergencyState(profileId: number, pageIndex: number, isEmergency: boolean): Promise<void> {
    try {
        const metadata = await getPageMetadata(profileId, pageIndex);
        
        // Check the current state to see if it's actually changing
        const currentState = metadata?.isEmergency || false;
        const isStateChanging = currentState !== isEmergency;
        
        await upsertPageMetadata({
            profileId,
            pageIndex,
            name: metadata?.name || `Bank ${pageIndex}`,
            isEmergency
        });
        
        console.log(`Set emergency state for page ${pageIndex} to ${isEmergency}`);
        
        // After successfully updating the page, increment the emergency sounds version 
        // to trigger a refresh - but only if the state actually changed
        if (isStateChanging) {
            useProfileStore.getState().incrementEmergencySoundsVersion();
            console.log(`Emergency state changed for page ${pageIndex}, triggered emergency sounds refresh`);
        }
    } catch (error) {
        console.error(`Error setting emergency state for page ${pageIndex}:`, error);
        throw error;
    }
}

// Export profile data
export interface ProfileExport {
  exportVersion: number;
  exportDate: string;
  profile: Profile;
  padConfigurations: PadConfiguration[];
  pageMetadata: PageMetadata[];
  audioFiles: {
    id: number;
    name: string;
    type: string;
    data: string; // Base64 encoded audio data
  }[];
}

// Export a profile to a JSON object
export async function exportProfile(profileId: number): Promise<ProfileExport> {
  try {
    // Get the profile data
    const profile = await getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile with ID ${profileId} not found`);
    }

    // Get all pad configurations for this profile
    const padConfigurations = await getAllPadConfigurationsForProfile(profileId);

    // Get all page metadata for this profile
    const pageMetadata = await getAllPageMetadataForProfile(profileId);
    
    // Get all audio files referenced by this profile's pads
    const audioFileIds = new Set<number>();
    padConfigurations.forEach(pad => {
      if (pad.audioFileId !== undefined) {
        audioFileIds.add(pad.audioFileId);
      }
    });
    
    // Convert audio blobs to base64
    const audioFiles = [];
    for (const audioFileId of audioFileIds) {
      const audioFile = await getAudioFile(audioFileId);
      if (audioFile) {
        const base64data = await blobToBase64(audioFile.blob);
        audioFiles.push({
          id: audioFileId,
          name: audioFile.name,
          type: audioFile.type,
          data: base64data
        });
      }
    }
    
    // Create the export object
    const exportData: ProfileExport = {
      exportVersion: 1, // Initial version
      exportDate: new Date().toISOString(),
      profile: { ...profile },
      padConfigurations,
      pageMetadata,
      audioFiles
    };
    
    return exportData;
  } catch (error) {
    console.error('Failed to export profile:', error);
    throw error;
  }
}

// Import a profile from an export object
export async function importProfile(exportData: ProfileExport): Promise<number> {
  const db = await getDb();
  let profileId: number;
  const now = new Date();
  
  try {
    // Step 1: Create a new profile (separate transaction)
    profileId = await createImportedProfile(db, exportData, now);
    console.log(`Created imported profile with ID ${profileId}`);
    
    // Step 2: Import audio files (separate transaction)
    const audioIdMap = await importAudioFiles(db, exportData.audioFiles, now);
    console.log(`Imported ${audioIdMap.size} audio files`);
    
    // Step 3: Import page metadata (separate transaction)
    await importPageMetadata(db, exportData.pageMetadata, profileId, now);
    console.log(`Imported page metadata`);
    
    // Step 4: Import pad configurations (separate transaction)
    await importPadConfigurations(db, exportData.padConfigurations, profileId, audioIdMap, now);
    console.log(`Imported pad configurations`);
    
    console.log(`Successfully completed profile import with ID ${profileId}`);
    return profileId;
  } catch (error) {
    console.error('Failed to import profile:', error);
    throw error;
  }
}

// Helper function to create a new profile for import
async function createImportedProfile(
  db: IDBPDatabase<ImpAmpDBSchema>, 
  exportData: ProfileExport, 
  now: Date
): Promise<number> {
  // Find a unique name for the profile
  const originalName = exportData.profile.name;
  let profileName = originalName;
  let counter = 1;
  let nameExists = true;
  
  // Separate transaction just to check names
  while (nameExists) {
    try {
      const nameTx = db.transaction('profiles', 'readonly');
      const nameIndex = nameTx.store.index('name');
      const existing = await nameIndex.get(profileName);
      await nameTx.done;
      
      if (!existing) {
        nameExists = false;
      } else {
        profileName = `${originalName} (${counter})`;
        counter++;
      }
    } catch (error) {
      console.error('Error checking profile name:', error);
      nameExists = false; // Break the loop on error
    }
  }
  
  // Now create the profile in a separate transaction
  const profileTx = db.transaction('profiles', 'readwrite');
  const profileStore = profileTx.objectStore('profiles');
  
  const newProfile = {
    name: profileName,
    syncType: exportData.profile.syncType,
    createdAt: now,
    updatedAt: now
  };
  
  const profileId = await profileStore.add(newProfile);
  await profileTx.done;
  
  return profileId;
}

// Helper function to import audio files
async function importAudioFiles(
  db: IDBPDatabase<ImpAmpDBSchema>, 
  audioFiles: ProfileExport['audioFiles'], 
  now: Date
): Promise<Map<number, number>> {
  // Create a map to store the original ID to new ID mapping
  const audioIdMap = new Map<number, number>();
  
  console.log(`Starting import of ${audioFiles.length} audio files`);
  
  // Import each audio file individually
  for (const audioFileExport of audioFiles) {
    try {
      // First convert base64 to blob OUTSIDE of any transaction
      console.log(`Converting audio file ${audioFileExport.name} from base64 to blob...`);
      const blob = await base64ToBlob(audioFileExport.data, audioFileExport.type);
      
      // Prepare the audio file object
      const newAudioFile = {
        blob,
        name: audioFileExport.name,
        type: audioFileExport.type,
        createdAt: now
      };
      
      // Now add the file to the database in a simple transaction
      let newAudioId: number;
      try {
        // Use the simpler method to add an audio file directly
        newAudioId = await addAudioFile(newAudioFile);
        
        // Add mapping of original ID to new ID
        audioIdMap.set(audioFileExport.id, newAudioId);
        console.log(`Successfully imported audio file: ${audioFileExport.name} (Original ID: ${audioFileExport.id}, New ID: ${newAudioId})`);
      } catch (dbError) {
        console.error(`Database error adding audio file ${audioFileExport.name}:`, dbError);
      }
    } catch (error) {
      console.error(`Failed to process audio file: ${audioFileExport.name}`, error);
    }
  }
  
  console.log(`Completed audio file import, mapped ${audioIdMap.size} files`);
  return audioIdMap;
}

// Helper function to import page metadata
async function importPageMetadata(
  db: IDBPDatabase<ImpAmpDBSchema>, 
  pageMetadata: PageMetadata[], 
  profileId: number, 
  now: Date
): Promise<void> {
  const pageTx = db.transaction('pageMetadata', 'readwrite');
  const pageStore = pageTx.objectStore('pageMetadata');
  
  // Create an array of promises for adding all page metadata
  const pagePromises = pageMetadata.map(page => 
    pageStore.add({
      profileId,
      pageIndex: page.pageIndex,
      name: page.name,
      isEmergency: page.isEmergency,
      createdAt: now,
      updatedAt: now
    })
  );
  
  // Wait for all page metadata to be added
  await Promise.all(pagePromises);
  
  // Complete the transaction
  await pageTx.done;
}

// Helper function to import pad configurations
async function importPadConfigurations(
  db: IDBPDatabase<ImpAmpDBSchema>, 
  padConfigurations: PadConfiguration[], 
  profileId: number, 
  audioIdMap: Map<number, number>, 
  now: Date
): Promise<void> {
  console.log(`Starting import of ${padConfigurations.length} pad configurations with audioIdMap size: ${audioIdMap.size}`);
  
  // Debug: Log the audio ID mappings
  audioIdMap.forEach((newId, oldId) => {
    console.log(`Audio ID mapping: ${oldId} -> ${newId}`);
  });

  // Import pad configurations one by one
  for (const pad of padConfigurations) {
    try {
      const padTx = db.transaction('padConfigurations', 'readwrite');
      const padStore = padTx.objectStore('padConfigurations');
      
      let mappedAudioId = undefined;
      if (pad.audioFileId !== undefined) {
        mappedAudioId = audioIdMap.get(pad.audioFileId);
        if (mappedAudioId === undefined) {
          console.warn(`No mapping found for audio ID ${pad.audioFileId} in pad at pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}`);
        } else {
          console.log(`Using mapped audio ID: ${pad.audioFileId} -> ${mappedAudioId}`);
        }
      }
      
      const newPad = {
        profileId,
        padIndex: pad.padIndex,
        pageIndex: pad.pageIndex,
        keyBinding: pad.keyBinding,
        name: pad.name,
        audioFileId: mappedAudioId,
        createdAt: now,
        updatedAt: now
      };
      
      // Add the pad configuration
      await padStore.add(newPad);
      await padTx.done;
      
      console.log(`Imported pad: pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}, with audioFileId ${mappedAudioId}`);
    } catch (error) {
      console.error(`Failed to import pad at pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}:`, error);
    }
  }
  
  console.log('Completed pad configuration import');
}

// Helper function to get all pad configurations for a profile
export async function getAllPadConfigurationsForProfile(profileId: number): Promise<PadConfiguration[]> {
  const db = await getDb();
  const tx = db.transaction('padConfigurations', 'readonly');
  const store = tx.objectStore('padConfigurations');
  const index = store.index('profileId');
  return index.getAll(profileId);
}

// Helper function to convert Blob to Base64 string
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => {
      reject(new Error('Failed to convert blob to base64'));
    };
    reader.readAsDataURL(blob);
  });
}

// Helper function to convert Base64 string to Blob
function base64ToBlob(base64: string, type: string): Promise<Blob> {
  // Decode base64
  const byteCharacters = atob(base64);
  const byteArrays = [];

  // Slice the byteCharacters into smaller chunks to prevent memory issues
  for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
    const slice = byteCharacters.slice(offset, offset + 1024);
    
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  return Promise.resolve(new Blob(byteArrays, { type }));
}

// Only initialize the database on the client side
if (isClient) {
  // Call getDb() early to initiate the connection and upgrade process
  getDb().catch(console.error);
}

// --- Impamp2 Import Functionality ---

/**
 * Imports a profile from the legacy impamp2 JSON export format.
 * Parses the data, transforms it to the current application's structure,
 * and saves it as a new profile.
 *
 * @param jsonData The JSON string content of the impamp2 export file.
 * @returns The ID of the newly created profile.
 */
export async function importImpamp2Profile(jsonData: string): Promise<number> {
  const db = await getDb();
  let profileId: number | undefined = undefined; // Initialize profileId
  const now = new Date();
  let impamp2Data: Impamp2Export;

  console.log("Starting impamp2 profile import...");

  // Step 1: Parse and validate the JSON data
  try {
    impamp2Data = JSON.parse(jsonData) as Impamp2Export;
    // Basic validation
    if (!impamp2Data || typeof impamp2Data.pages !== 'object' || impamp2Data.pages === null) {
      throw new Error('Invalid impamp2 JSON structure: "pages" object not found or invalid.');
    }
    console.log(`Parsed impamp2 JSON successfully. Found ${Object.keys(impamp2Data.pages).length} pages.`);
  } catch (error) {
    console.error('Failed to parse impamp2 JSON:', error);
    const message = error instanceof Error ? error.message : 'Unknown parsing error';
    throw new Error(`Invalid impamp2 JSON format: ${message}`);
  }

  // Step 2: Create a placeholder profile name (will be refined by createImportedProfile)
  // We need a name to pass to createImportedProfile, even if it gets modified.
  // Let's try to find the name of the first page, or default to "Imported Impamp2 Profile".
  const firstPageKey = Object.keys(impamp2Data.pages)[0];
  const initialProfileName = firstPageKey ? impamp2Data.pages[firstPageKey]?.name || 'Imported Impamp2 Profile' : 'Imported Impamp2 Profile';

  // Create a temporary Profile object structure similar to ProfileExport for createImportedProfile
  const pseudoExportData = {
    exportVersion: 0, // Indicate it's not a standard export
    exportDate: now.toISOString(),
    profile: {
      name: initialProfileName,
      syncType: 'local' as SyncType, // Assume local sync for imported impamp2 profiles
      createdAt: now,
      updatedAt: now,
    },
    // Provide empty arrays for other parts expected by createImportedProfile
    padConfigurations: [],
    pageMetadata: [],
    audioFiles: [],
  };

  try {
    // Step 3: Create the new profile entry (handles name conflicts)
    // Assign the result to profileId
    profileId = await createImportedProfile(db, pseudoExportData, now);
    console.log(`Created base profile entry for impamp2 import with ID: ${profileId}`);

    // Step 4: Iterate through pages and pads, transform, and save
    for (const pageNoStr in impamp2Data.pages) {
      if (!Object.prototype.hasOwnProperty.call(impamp2Data.pages, pageNoStr)) continue;

      const pageData = impamp2Data.pages[pageNoStr];
      const pageIndex = parseInt(pageNoStr, 10);

      if (isNaN(pageIndex)) {
        console.warn(`Skipping page with invalid page number key: ${pageNoStr}`);
        continue;
      }

      console.log(`Processing page ${pageIndex}: "${pageData.name}"`);

      // Save page metadata
      try {
        await upsertPageMetadata({
          profileId,
          pageIndex,
          name: pageData.name || `Page ${pageIndex + 1}`, // Use page name or default
          isEmergency: false, // Assume false for impamp2 imports
        });
        console.log(`Saved metadata for page ${pageIndex}`);
      } catch (error) {
        console.error(`Failed to save metadata for page ${pageIndex}:`, error);
        // Continue processing other pages/pads even if metadata fails
      }

      // Process pads within the page
      for (const key in pageData.pads) {
        if (!Object.prototype.hasOwnProperty.call(pageData.pads, key)) continue;

        const padData = pageData.pads[key];
        console.log(`Processing pad with key "${key}" on page ${pageIndex}`);

        // Map key to padIndex
        const padIndex = getPadIndexForKey(key);
        if (padIndex === undefined) {
          console.warn(`Skipping pad: No valid pad index found for key "${key}" on page ${pageIndex}.`);
          continue;
        }
        console.log(`Mapped key "${key}" to padIndex ${padIndex}`);

        // Extract audio data
        const dataUrl = padData.file;
        if (!dataUrl || !dataUrl.startsWith('data:audio/')) {
          console.warn(`Skipping pad "${padData.name}" (key: ${key}, page: ${pageIndex}): Invalid or missing audio data URL.`);
          continue;
        }

        let audioFileId: number | undefined = undefined;
        try {
          // Parse data URL
          const parts = dataUrl.match(/^data:(.+);base64,(.+)$/);
          if (!parts || parts.length !== 3) {
            throw new Error('Could not parse data URL format.');
          }
          const mimeType = parts[1];
          const base64Data = parts[2];

          // Convert base64 to Blob
          console.log(`Converting base64 to blob for pad "${padData.name}"...`);
          const blob = await base64ToBlob(base64Data, mimeType);
          console.log(`Blob created with type ${blob.type} and size ${blob.size}`);

          // Add audio file to DB
          audioFileId = await addAudioFile({
            blob,
            name: padData.filename || padData.name || `imported_audio_${profileId}_${pageIndex}_${padIndex}`,
            type: mimeType,
          });
          console.log(`Saved audio file for pad "${padData.name}", got audioFileId: ${audioFileId}`);

        } catch (error) {
          console.error(`Failed to process or save audio for pad "${padData.name}" (key: ${key}, page: ${pageIndex}):`, error);
          // Continue to next pad, but this pad won't have audio
        }

        // Save pad configuration
        try {
          await upsertPadConfiguration({
            profileId,
            pageIndex,
            padIndex,
            keyBinding: key, // Store the original key
            name: padData.name || padData.filename || `Pad ${padIndex}`,
            audioFileId: audioFileId, // Will be undefined if audio processing failed
          });
          console.log(`Saved pad configuration for page ${pageIndex}, padIndex ${padIndex}`);
        } catch (error) {
          console.error(`Failed to save pad configuration for page ${pageIndex}, padIndex ${padIndex}:`, error);
          // Continue processing other pads
        }
      } // End pad loop
    } // End page loop

    console.log(`Successfully completed impamp2 profile import. New profile ID: ${profileId}`);
    return profileId;

  } catch (error) {
    console.error('Critical error during impamp2 profile import process:', error);
    // Attempt to clean up the partially created profile if an error occurred after creation
    // Check if profileId was successfully assigned before attempting cleanup
    if (profileId !== undefined) {
      console.warn(`Attempting to delete partially imported profile ID: ${profileId}`);
      try {
        await deleteProfile(profileId); // Use the assigned profileId
        console.log(`Cleaned up partially imported profile ID: ${profileId}`);
      } catch (cleanupError) {
        console.error(`Failed to clean up partially imported profile ID: ${profileId}`, cleanupError);
      }
    }
    throw error; // Re-throw the original error
  }
}
