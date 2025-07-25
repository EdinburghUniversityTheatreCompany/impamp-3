import { IDBPDatabase } from "idb";
import {
  AudioFile,
  Profile,
  PadConfiguration,
  // PlaybackType, // Removed unused import (it's part of PadConfiguration)
  PageMetadata,
  SyncType,
  ImpAmpDBSchema,
  getAudioFile,
  getProfile,
  getAllPageMetadataForProfile,
  deleteProfile, // Needed for cleanup in importImpamp2Profile error handling
} from "./db"; // Import necessary types and DB functions from db.ts
import { getPadIndexForKey } from "./keyboardUtils";

/**
 * Represents a single pad within an impamp2 page.
 * Note: The 'file' property contains a data URL string.
 */
export interface Impamp2Pad {
  page: string; // Page number as a string (e.g., "0", "1")
  key: string; // Keyboard key associated with the pad (e.g., "q", "a", ";")
  name: string; // Display name of the pad/sound
  file: string; // Data URL string (e.g., "data:audio/mpeg;base64,<BASE_64_STRING>")
  filename: string; // Original filename
  filesize: number; // File size in bytes
  startTime: number | null; // Start time for playback (likely unused in import)
  endTime: number | null; // End time for playback (likely unused in import)
  updatedAt: number; // Timestamp of last update
  readable: boolean; // Indicates if the file is readable (likely always true for export)
}

/**
 * Represents a single page (bank) within an impamp2 export.
 * Pads are stored in an object keyed by the keyboard character.
 */
export interface Impamp2Page {
  pageNo: string; // Page number as a string (e.g., "0", "1")
  name: string; // Name of the page/bank
  emergencies: number; // Count of emergencies (likely unused in import)
  updatedAt: number; // Timestamp of last update
  pads: {
    [key: string]: Impamp2Pad; // Pads keyed by keyboard character (e.g., "'", ";", "a", "b")
  };
}

/**
 * Represents the top-level structure of an impamp2 export file.
 * Pages are stored in an object keyed by the page number string.
 */
export interface Impamp2Export {
  padCount: number; // Total count of pads across all pages
  pages: {
    [pageNo: string]: Impamp2Page; // Pages keyed by page number string (e.g., "0", "1")
  };
}

// --- Export/Import Interfaces and Functions moved from db.ts ---

// Export profile data structure V2 (includes multi-sound fields)
// Note: The profile object here should EXCLUDE lastBackedUpAt
export interface ProfileExport {
  exportVersion: number; // Increment to 2 for new format
  exportDate: string;
  profile: Omit<Profile, "lastBackedUpAt"> & { id?: number }; // Ensure lastBackedUpAt is excluded, but keep others
  padConfigurations: PadConfiguration[]; // This now uses the updated PadConfiguration type
  pageMetadata: PageMetadata[];
  audioFiles: {
    id: number;
    name: string;
    type: string;
    data: string; // Base64 encoded audio data
  }[];
}

// --- Multi-Profile Export/Import ---
export interface MultiProfileExport {
  exportVersion: number; // e.g., 1 for this multi-export format
  exportDate: string;
  profiles: ProfileExport[]; // An array of individual profile exports
}

// Helper function to convert Blob to Base64 string
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Ensure the result is a string and contains the expected prefix
      if (typeof dataUrl === "string" && dataUrl.includes(",")) {
        const base64 = dataUrl.split(",")[1];
        resolve(base64);
      } else {
        reject(new Error("Failed to read blob as data URL or invalid format"));
      }
    };
    reader.onerror = (error) => {
      console.error("FileReader error:", error);
      reject(new Error("Failed to convert blob to base64"));
    };
    reader.readAsDataURL(blob);
  });
}

// Helper function to convert Base64 string to Blob
export function base64ToBlob(base64: string, type: string): Promise<Blob> {
  try {
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
  } catch (error) {
    console.error("Error converting base64 to Blob:", error);
    return Promise.reject(error); // Propagate the error
  }
}

// Helper function to get all pad configurations for a profile (Needed by exportProfile)
export async function getAllPadConfigurationsForProfile(
  profileId: number,
): Promise<PadConfiguration[]> {
  // This function now needs access to getDb
  const { getDb } = await import("./db"); // Dynamically import getDb to avoid circular dependency issues at module load time
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readonly");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profileId");
  return index.getAll(profileId);
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
    const padConfigurations =
      await getAllPadConfigurationsForProfile(profileId);

    // Get all page metadata for this profile
    const pageMetadata = await getAllPageMetadataForProfile(profileId);

    // Get all unique audio file IDs referenced by this profile's pads
    const audioFileIds = new Set<number>();
    padConfigurations.forEach((pad) => {
      if (pad.audioFileIds && pad.audioFileIds.length > 0) {
        pad.audioFileIds.forEach((id) => audioFileIds.add(id));
      }
    });

    // Convert audio blobs to base64
    const audioFiles = [];
    for (const audioFileId of audioFileIds) {
      const audioFile = await getAudioFile(audioFileId);
      if (audioFile) {
        const base64data = await blobToBase64(audioFile.blob);
        audioFiles.push({
          id: audioFileId, // Keep original ID for reference in export, map on import
          name: audioFile.name,
          type: audioFile.type,
          data: base64data,
        });
      } else {
        console.warn(
          `Audio file with ID ${audioFileId} referenced in profile but not found in DB.`,
        );
      }
    }

    // Create the export object, explicitly excluding lastBackedUpAt
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { lastBackedUpAt, ...profileToExport } = profile; // Destructure to omit lastBackedUpAt

    const exportData: ProfileExport = {
      exportVersion: 2, // Mark as new version
      exportDate: new Date().toISOString(),
      profile: profileToExport, // Use the cloned profile data without lastBackedUpAt
      padConfigurations, // Already contains the new structure
      pageMetadata,
      audioFiles,
    };

    return exportData;
  } catch (error) {
    console.error("Failed to export profile:", error);
    throw error;
  }
}

/**
 * Exports multiple profiles into a single structure.
 * @param profileIds An array of profile IDs to export.
 * @returns A Promise resolving to the MultiProfileExport object.
 */
export async function exportMultipleProfiles(
  profileIds: number[],
): Promise<MultiProfileExport> {
  console.log(`Starting export for ${profileIds.length} profiles...`);
  const profileExports: ProfileExport[] = [];
  const errors: { profileId: number; error: Error }[] = []; // Use Error type instead of any

  for (const profileId of profileIds) {
    try {
      console.log(`Exporting profile ID: ${profileId}`);
      const singleExport = await exportProfile(profileId); // Reuse existing function
      profileExports.push(singleExport);
      console.log(`Successfully exported profile ID: ${profileId}`);
    } catch (error) {
      console.error(`Failed to export profile ID ${profileId}:`, error);
      // Ensure the caught object is an Error before pushing
      errors.push({
        profileId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      // Continue exporting other profiles even if one fails
    }
  }

  if (errors.length > 0) {
    // Log a warning if some profiles failed to export
    console.warn(
      `Export completed with ${errors.length} errors for profile IDs: ${errors.map((e) => e.profileId).join(", ")}`,
    );
    // Depending on requirements, we might want to throw here or return partial data with error info
  }

  const multiExportData: MultiProfileExport = {
    exportVersion: 1, // Version for the multi-export format
    exportDate: new Date().toISOString(),
    profiles: profileExports,
  };

  console.log(`Finished exporting ${profileExports.length} profiles.`);
  return multiExportData;
}

// --- Profile Import Logic ---

// Helper function to create a new profile for import, handling name conflicts
async function createImportedProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  exportData: ProfileExport | { profile: Partial<Profile> & { name: string } }, // Allow partial for impamp2
  now: Date,
): Promise<number> {
  // Import DEFAULT_BACKUP_REMINDER_PERIOD_MS for default value during import
  const { DEFAULT_BACKUP_REMINDER_PERIOD_MS } = await import("./db");

  // Find a unique name for the profile
  const originalName = exportData.profile.name || "Imported Profile"; // Default name if missing
  let profileName = originalName;
  let counter = 1;
  let nameExists = true;

  // Separate transaction just to check names
  while (nameExists) {
    try {
      const nameTx = db.transaction("profiles", "readonly");
      const nameIndex = nameTx.store.index("name");
      const existing = await nameIndex.get(profileName);
      await nameTx.done;

      if (!existing) {
        nameExists = false;
      } else {
        profileName = `${originalName} (${counter})`;
        counter++;
      }
    } catch (error) {
      console.error("Error checking profile name:", error);
      // Decide how to handle this - maybe throw, maybe break loop and use potentially non-unique name
      throw new Error(
        `Failed to check profile name uniqueness: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Now create the profile in a separate transaction
  const profileTx = db.transaction("profiles", "readwrite");
  const profileStore = profileTx.objectStore("profiles");

  const newProfileData: Omit<Profile, "id"> = {
    name: profileName,
    // Use syncType from export if available, otherwise default to 'local'
    syncType: (exportData.profile as Profile).syncType || "local",
    googleDriveFileId:
      (exportData.profile as Profile).googleDriveFileId ?? null,
    // googleDriveFolderId and lastSyncedEtag are removed from Profile interface
    activePadBehavior: (exportData.profile as Profile).activePadBehavior,
    // Handle backup fields on import
    lastBackedUpAt: now.getTime(), // Set lastBackedUpAt to import time
    backupReminderPeriod:
      (exportData.profile as Profile).backupReminderPeriod ?? // Use imported value if present
      DEFAULT_BACKUP_REMINDER_PERIOD_MS, // Otherwise use default
    createdAt: now,
    updatedAt: now,
  };

  const profileId = await profileStore.add(newProfileData);
  await profileTx.done;

  return profileId;
}

// Helper function to import audio files (Refactored for single transaction)
async function importAudioFiles(
  db: IDBPDatabase<ImpAmpDBSchema>,
  audioFiles: ProfileExport["audioFiles"],
  now: Date,
): Promise<Map<number, number>> {
  const audioIdMap = new Map<number, number>();
  console.log(`Starting import of ${audioFiles.length} audio files`);

  // Prepare audio data outside the transaction
  const preparedAudio = [];
  for (const audioFileExport of audioFiles) {
    try {
      console.log(
        `Preparing audio file ${audioFileExport.name} (Original ID: ${audioFileExport.id})...`,
      );
      const blob = await base64ToBlob(
        audioFileExport.data,
        audioFileExport.type,
      );
      preparedAudio.push({
        originalId: audioFileExport.id,
        fileData: {
          blob,
          name: audioFileExport.name,
          type: audioFileExport.type,
          createdAt: now,
        },
      });
    } catch (error) {
      console.error(
        `Failed to prepare audio file: ${audioFileExport.name} (Original ID: ${audioFileExport.id})`,
        error,
      );
      // Skip this file, but continue with others
    }
  }

  // Perform all additions in a single transaction
  if (preparedAudio.length > 0) {
    const audioTx = db.transaction("audioFiles", "readwrite");
    const audioStore = audioTx.objectStore("audioFiles");
    const addPromises = preparedAudio.map(async (item) => {
      try {
        const newAudioId = await audioStore.add(item.fileData);
        audioIdMap.set(item.originalId, newAudioId);
        console.log(
          `Added audio file: ${item.fileData.name} (Original ID: ${item.originalId}, New ID: ${newAudioId})`,
        );
      } catch (dbError) {
        console.error(
          `Database error adding audio file ${item.fileData.name} (Original ID: ${item.originalId}):`,
          dbError,
        );
        // Don't map this ID if add fails
      }
    });

    try {
      await Promise.all(addPromises);
      await audioTx.done;
      console.log("Audio file transaction committed.");
    } catch (txError) {
      console.error("Error during audio file import transaction:", txError);
      // Note: IDs added before the error might still be in the map, but the transaction failed.
      // Consider clearing the map or handling this state if partial success is problematic.
      audioIdMap.clear(); // Clear map on transaction failure
      throw txError; // Re-throw transaction error
    }
  } else {
    console.log("No audio files prepared for import.");
  }

  console.log(`Completed audio file import, mapped ${audioIdMap.size} files`);
  return audioIdMap;
}

// Helper function to import page metadata (Refactored for single transaction)
async function importPageMetadata(
  db: IDBPDatabase<ImpAmpDBSchema>,
  pageMetadata: PageMetadata[],
  profileId: number,
  now: Date,
): Promise<void> {
  if (pageMetadata.length === 0) {
    console.log("No page metadata to import.");
    return;
  }

  const pageTx = db.transaction("pageMetadata", "readwrite");
  const pageStore = pageTx.objectStore("pageMetadata");

  const pagePromises = pageMetadata.map((page) => {
    const newMetadata = {
      profileId,
      pageIndex: page.pageIndex,
      name: page.name,
      isEmergency: page.isEmergency,
      createdAt: now,
      updatedAt: now,
    };
    return pageStore.add(newMetadata).catch((err) => {
      console.error(
        `Failed to add page metadata for pageIndex ${page.pageIndex}:`,
        err,
      );
      // Decide if one failure should abort the whole transaction (by throwing)
      // or just log and continue (current behavior)
    });
  });

  try {
    await Promise.all(pagePromises);
    await pageTx.done;
    console.log(`Imported ${pageMetadata.length} page metadata entries.`);
  } catch (txError) {
    console.error("Error during page metadata import transaction:", txError);
    throw txError; // Re-throw transaction error
  }
}

// Helper function to import pad configurations (Refactored for single transaction)
async function importPadConfigurations(
  db: IDBPDatabase<ImpAmpDBSchema>,
  padConfigurations: PadConfiguration[], // Expects array with new structure
  profileId: number,
  audioIdMap: Map<number, number>, // Maps original ID from export to new DB ID
  now: Date,
): Promise<void> {
  if (padConfigurations.length === 0) {
    console.log("No pad configurations to import.");
    return;
  }

  console.log(
    `Starting import of ${padConfigurations.length} pad configurations.`,
  );

  const padTx = db.transaction("padConfigurations", "readwrite");
  const padStore = padTx.objectStore("padConfigurations");

  const padPromises = padConfigurations.map((pad) => {
    // Map the array of audioFileIds
    const mappedAudioFileIds = (pad.audioFileIds || [])
      .map((originalId) => audioIdMap.get(originalId))
      .filter((newId): newId is number => newId !== undefined); // Filter out undefined results

    if (
      (pad.audioFileIds || []).length > 0 &&
      mappedAudioFileIds.length !== (pad.audioFileIds || []).length
    ) {
      console.warn(
        `Could not map all audio IDs for pad at pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}. Original: ${pad.audioFileIds}, Mapped: ${mappedAudioFileIds}`,
      );
    }

    // Construct the new pad configuration using the updated structure
    const newPadData: Omit<PadConfiguration, "id"> = {
      profileId,
      padIndex: pad.padIndex,
      pageIndex: pad.pageIndex,
      keyBinding: pad.keyBinding,
      name: pad.name,
      audioFileIds: mappedAudioFileIds, // Use the mapped array
      playbackType: pad.playbackType || "sequential", // Use imported type or default
      createdAt: now,
      updatedAt: now,
    };

    return padStore.add(newPadData).catch((err) => {
      console.error(
        `Failed to add pad configuration for pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}:`,
        err,
      );
      // Decide if one failure should abort the whole transaction (by throwing)
      // or just log and continue (current behavior)
    });
  });

  try {
    await Promise.all(padPromises);
    await padTx.done;
    console.log(`Imported ${padConfigurations.length} pad configurations.`);
  } catch (txError) {
    console.error(
      "Error during pad configuration import transaction:",
      txError,
    );
    throw txError; // Re-throw transaction error
  }
}

// Import a profile from a standard export object
export async function importProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  exportData: ProfileExport,
): Promise<number> {
  let profileId: number | undefined = undefined;
  const now = new Date();
  let padConfigsToImport: PadConfiguration[] = exportData.padConfigurations; // Start with potentially new format

  // Define a type for the old format for cleaner casting
  type OldPadConfigFormat = Omit<
    PadConfiguration,
    "audioFileIds" | "playbackType"
  > & { audioFileId?: number };

  try {
    // --- Backward Compatibility Check ---
    // Check if the first pad config uses the old format (has audioFileId)
    const isOldFormat =
      exportData.padConfigurations.length > 0 &&
      exportData.padConfigurations[0].hasOwnProperty("audioFileId");

    if (isOldFormat) {
      console.log(
        "Importing old format (V1) profile export. Migrating pad configurations...",
      );
      // Use the defined type for mapping and casting
      padConfigsToImport = (
        exportData.padConfigurations as OldPadConfigFormat[]
      ).map((oldPad): PadConfiguration => {
        const audioFileIds: number[] = [];
        if (
          oldPad.audioFileId !== undefined &&
          typeof oldPad.audioFileId === "number"
        ) {
          audioFileIds.push(oldPad.audioFileId);
        }
        // Create a new object conforming to the current PadConfiguration interface
        const migratedPad: PadConfiguration = {
          id: oldPad.id, // Keep original ID if present (though it's usually omitted in export)
          profileId: oldPad.profileId, // Will be overwritten later
          pageIndex: oldPad.pageIndex,
          padIndex: oldPad.padIndex,
          keyBinding: oldPad.keyBinding,
          name: oldPad.name,
          audioFileIds: audioFileIds,
          playbackType: "sequential", // Default for old format
          createdAt: oldPad.createdAt || now, // Use existing or new date
          updatedAt: oldPad.updatedAt || now, // Use existing or new date
        };
        // delete (migratedPad as any).audioFileId; // Ensure old field is gone (optional, spread below handles it)
        return migratedPad;
      });
    } else if (exportData.exportVersion !== 2) {
      // If not old format and not V2, it's an unknown/unsupported version
      console.warn(
        `Importing profile with unknown or unsupported version: ${exportData.exportVersion ?? "undefined"}. Proceeding with caution.`,
      );
      // Allow import but log warning
    }
    // --- End Backward Compatibility Check ---

    // Step 1: Create the new profile entry (handles name conflicts)
    profileId = await createImportedProfile(db, exportData, now);
    console.log(`Created imported profile with ID ${profileId}`);

    // Step 2: Import audio files (single transaction)
    const audioIdMap = await importAudioFiles(db, exportData.audioFiles, now);
    console.log(`Imported ${audioIdMap.size} audio files`);

    // Step 3: Import page metadata (single transaction)
    await importPageMetadata(db, exportData.pageMetadata, profileId, now);
    console.log(`Imported page metadata`);

    // Step 4: Import pad configurations (single transaction) - Use potentially migrated data
    await importPadConfigurations(
      db,
      padConfigsToImport, // Use the processed array
      profileId,
      audioIdMap,
      now,
    );
    console.log(`Imported pad configurations`);

    console.log(`Successfully completed profile import with ID ${profileId}`);
    return profileId;
  } catch (error) {
    console.error("Failed to import profile:", error);
    // Attempt cleanup if profile was created
    if (profileId !== undefined) {
      console.warn(
        `Attempting to delete partially imported profile ID: ${profileId}`,
      );
      try {
        // Need a separate DB call here as the original transaction likely failed
        await deleteProfile(profileId);
        console.log(`Cleaned up partially imported profile ID: ${profileId}`);
      } catch (cleanupError) {
        console.error(
          `Failed to clean up partially imported profile ID: ${profileId}`,
          cleanupError,
        );
      }
    }
    throw error; // Re-throw the original import error
  }
}

/**
 * Imports multiple profiles from a MultiProfileExport object.
 * @param db The IDBPDatabase instance.
 * @param multiExportData The data containing multiple profile exports.
 * @returns A Promise resolving to an array of results (new profile ID or error).
 */
export async function importMultipleProfiles(
  db: IDBPDatabase<ImpAmpDBSchema>,
  multiExportData: MultiProfileExport,
): Promise<{ profileName: string; result: number | Error }[]> {
  console.log(
    `Starting import of ${multiExportData.profiles.length} profiles from multi-export...`,
  );

  // Basic validation of the multi-export format
  if (
    multiExportData.exportVersion !== 1 ||
    !Array.isArray(multiExportData.profiles)
  ) {
    console.error(
      "Invalid or unsupported multi-profile export format detected.",
      multiExportData,
    );
    throw new Error("Invalid or unsupported multi-profile export format.");
  }

  const importResults: { profileName: string; result: number | Error }[] = [];

  for (const singleExportData of multiExportData.profiles) {
    // Attempt to get a meaningful name for logging/reporting, default if missing
    const profileName = singleExportData?.profile?.name || "Unnamed Profile";
    try {
      console.log(
        `Attempting to import profile: "${profileName}" from multi-export.`,
      );
      // Reuse the existing single import function
      const newProfileId = await importProfile(db, singleExportData);
      importResults.push({ profileName, result: newProfileId });
      console.log(
        `Successfully imported profile "${profileName}" as new ID: ${newProfileId}`,
      );
    } catch (error) {
      console.error(
        `Failed to import profile "${profileName}" from multi-export:`,
        error,
      );
      // Store the error object itself for better debugging downstream
      importResults.push({
        profileName,
        result: error instanceof Error ? error : new Error(String(error)),
      });
      // Continue with the next profile import
    }
  }

  console.log(
    `Finished importing profiles from multi-export. Results count: ${importResults.length}`,
  );
  // Log summary of successes/failures
  const successes = importResults.filter(
    (r) => typeof r.result === "number",
  ).length;
  const failures = importResults.length - successes;
  console.log(
    `Multi-import summary: ${successes} succeeded, ${failures} failed.`,
  );

  return importResults;
}

// --- Impamp2 Import Functionality ---

/**
 * Imports a profile from the legacy impamp2 JSON export format.
 * Parses the data, transforms it to the current application's structure,
 * and saves it as a new profile.
 *
 * @param db The IDBPDatabase instance.
 * @param jsonData The JSON string content of the impamp2 export file.
 * @returns The ID of the newly created profile.
 */
export async function importImpamp2Profile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  jsonData: string,
): Promise<number> {
  let profileId: number | undefined = undefined; // Initialize profileId
  const now = new Date();
  let impamp2Data: Impamp2Export;

  console.log("Starting impamp2 profile import...");

  // Step 1: Parse and validate the JSON data
  try {
    impamp2Data = JSON.parse(jsonData) as Impamp2Export;
    // Basic validation
    if (
      !impamp2Data ||
      typeof impamp2Data.pages !== "object" ||
      impamp2Data.pages === null
    ) {
      throw new Error(
        'Invalid impamp2 JSON structure: "pages" object not found or invalid.',
      );
    }
    console.log(
      `Parsed impamp2 JSON successfully. Found ${Object.keys(impamp2Data.pages).length} pages.`,
    );
  } catch (error) {
    console.error("Failed to parse impamp2 JSON:", error);
    const message =
      error instanceof Error ? error.message : "Unknown parsing error";
    throw new Error(`Invalid impamp2 JSON format: ${message}`);
  }

  // Step 2: Create a placeholder profile name
  const firstPageKey = Object.keys(impamp2Data.pages)[0];
  const initialProfileName = firstPageKey
    ? impamp2Data.pages[firstPageKey]?.name || "Imported Impamp2 Profile"
    : "Imported Impamp2 Profile";

  // Create a temporary structure for createImportedProfile
  const pseudoExportData = {
    profile: {
      name: initialProfileName,
      syncType: "local" as SyncType, // Assume local sync
    },
  };

  try {
    // Step 3: Create the new profile entry (handles name conflicts)
    profileId = await createImportedProfile(db, pseudoExportData, now);
    console.log(
      `Created base profile entry for impamp2 import with ID: ${profileId}`,
    );

    // Step 4: Prepare data for bulk import (audio, pages, pads)
    const audioToImport: {
      originalKey: string;
      pageIndex: number;
      padIndex: number;
      data: Omit<AudioFile, "id" | "createdAt">;
    }[] = [];
    const pagesToImport: Omit<
      PageMetadata,
      "id" | "createdAt" | "updatedAt"
    >[] = [];
    // Corrected type definition for padsToImport
    const padsToImport: {
      originalKey: string;
      pageIndex: number;
      padIndex: number;
      data: Omit<
        PadConfiguration,
        "id" | "createdAt" | "updatedAt" | "audioFileId"
      >;
      audioOriginalKey?: string; // Moved audioOriginalKey here
    }[] = [];

    for (const pageNoStr in impamp2Data.pages) {
      if (!Object.prototype.hasOwnProperty.call(impamp2Data.pages, pageNoStr))
        continue;

      const pageData = impamp2Data.pages[pageNoStr];
      const pageIndex = parseInt(pageNoStr, 10);

      if (isNaN(pageIndex)) {
        console.warn(
          `Skipping page with invalid page number key: ${pageNoStr}`,
        );
        continue;
      }

      console.log(`Preparing page ${pageIndex}: "${pageData.name}"`);
      pagesToImport.push({
        profileId,
        pageIndex,
        name: pageData.name || `Page ${pageIndex + 1}`,
        isEmergency: false,
      });

      for (const key in pageData.pads) {
        if (!Object.prototype.hasOwnProperty.call(pageData.pads, key)) continue;

        const padData = pageData.pads[key];
        const padIndex = getPadIndexForKey(key);

        if (padIndex === undefined) {
          console.warn(
            `Skipping pad: No valid pad index found for key "${key}" on page ${pageIndex}.`,
          );
          continue;
        }

        const dataUrl = padData.file;
        let audioOriginalKey: string | undefined = undefined;

        // Process audio data for this pad
        console.log(
          `Processing pad "${padData.name}" (key: ${key}, page: ${pageIndex})`,
        );
        if (dataUrl) {
          console.log(
            `  - Data URL detected (${dataUrl.length} chars), MIME: ${dataUrl.split(";")[0].split(":")[1] || "unknown"}`,
          );
        }

        // Accept both proper audio MIME types and generic octet-stream (legacy V1 format)
        if (
          dataUrl &&
          (dataUrl.startsWith("data:audio/") ||
            dataUrl.startsWith("data:application/octet-stream"))
        ) {
          try {
            const parts = dataUrl.match(/^data:(.+);base64,(.+)$/);
            if (!parts || parts.length !== 3)
              throw new Error("Could not parse data URL format.");
            let mimeType = parts[1];
            const base64Data = parts[2];

            // Fix legacy V1 MIME type: application/octet-stream should be treated as audio
            if (mimeType === "application/octet-stream") {
              // Try to determine actual audio format from filename or default to mp3
              const filename = padData.filename || padData.name || "";
              if (filename.toLowerCase().includes(".wav")) {
                mimeType = "audio/wav";
              } else if (filename.toLowerCase().includes(".ogg")) {
                mimeType = "audio/ogg";
              } else if (filename.toLowerCase().includes(".m4a")) {
                mimeType = "audio/mp4";
              } else {
                // Default to mp3 for unknown legacy formats
                mimeType = "audio/mpeg";
              }
              console.log(
                `Fixed legacy MIME type for "${padData.name}": application/octet-stream -> ${mimeType}`,
              );
            }

            const blob = await base64ToBlob(base64Data, mimeType); // Convert outside transaction

            audioOriginalKey = `${profileId}_${pageIndex}_${padIndex}`; // Unique key for mapping later
            audioToImport.push({
              originalKey: audioOriginalKey,
              pageIndex,
              padIndex,
              data: {
                blob,
                name:
                  padData.filename ||
                  padData.name ||
                  `imported_audio_${audioOriginalKey}`,
                type: mimeType,
              },
            });
          } catch (error) {
            console.error(
              `Failed to prepare audio for pad "${padData.name}" (key: ${key}, page: ${pageIndex}):`,
              error,
            );
            // Audio won't be added, audioOriginalKey remains undefined
          }
        } else {
          console.warn(
            `Skipping audio for pad "${padData.name}" (key: ${key}, page: ${pageIndex}): Invalid or missing audio data URL.`,
          );
          if (
            dataUrl &&
            typeof dataUrl === "string" &&
            dataUrl.startsWith("data:")
          ) {
            console.warn(
              `  - Unsupported data URL format: ${dataUrl.substring(0, 50)}...`,
            );
          }
        }

        padsToImport.push({
          originalKey: key,
          pageIndex,
          padIndex,
          data: {
            profileId,
            pageIndex,
            padIndex,
            keyBinding: key,
            name: padData.name || padData.filename || `Pad ${padIndex}`,
            audioFileIds: [], // Initialize with empty array
            playbackType: "sequential", // Initialize with default
          },
          audioOriginalKey, // Link pad to prepared audio
        });
      } // End pad loop
    } // End page loop

    // Step 5: Bulk import audio files (single transaction)
    const audioKeyToIdMap = new Map<string, number>();
    if (audioToImport.length > 0) {
      const audioTx = db.transaction("audioFiles", "readwrite");
      const audioStore = audioTx.objectStore("audioFiles");
      const audioPromises = audioToImport.map((item) =>
        audioStore
          .add({ ...item.data, createdAt: now })
          .then((id) => {
            audioKeyToIdMap.set(item.originalKey, id);
            console.log(`Added audio: ${item.data.name}, New ID: ${id}`);
          })
          .catch((err) =>
            console.error(`Failed to add audio ${item.data.name}:`, err),
          ),
      );
      await Promise.all(audioPromises);
      await audioTx.done;
      console.log(
        `Imported ${audioKeyToIdMap.size} audio files from impamp2 data.`,
      );
    }

    // Step 6: Bulk import page metadata (single transaction)
    if (pagesToImport.length > 0) {
      const pageTx = db.transaction("pageMetadata", "readwrite");
      const pageStore = pageTx.objectStore("pageMetadata");
      const pagePromises = pagesToImport.map((pageData) =>
        pageStore
          .add({ ...pageData, createdAt: now, updatedAt: now })
          .catch((err) =>
            console.error(
              `Failed to add page metadata for pageIndex ${pageData.pageIndex}:`,
              err,
            ),
          ),
      );
      await Promise.all(pagePromises);
      await pageTx.done;
      console.log(
        `Imported ${pagesToImport.length} page metadata entries from impamp2 data.`,
      );
    }

    // Step 7: Bulk import pad configurations (single transaction)
    if (padsToImport.length > 0) {
      const padTx = db.transaction("padConfigurations", "readwrite");
      const padStore = padTx.objectStore("padConfigurations");
      const padPromises = padsToImport.map((item) => {
        const audioFileId = item.audioOriginalKey
          ? audioKeyToIdMap.get(item.audioOriginalKey)
          : undefined;
        if (item.audioOriginalKey && audioFileId === undefined) {
          console.warn(
            `Could not find imported audio ID for original key ${item.audioOriginalKey} (Pad key: ${item.originalKey}, Page: ${item.pageIndex})`,
          );
        }
        // Construct the final pad data with the new structure
        const finalPadData: Omit<PadConfiguration, "id"> = {
          ...item.data,
          audioFileIds: audioFileId !== undefined ? [audioFileId] : [], // Set as array
          playbackType: "sequential", // Default for impamp2 import
          createdAt: now,
          updatedAt: now,
        };
        return padStore
          .add(finalPadData)
          .catch((err) =>
            console.error(
              `Failed to add pad config for key ${item.originalKey}, pageIndex ${item.pageIndex}:`,
              err,
            ),
          );
      });
      await Promise.all(padPromises);
      await padTx.done;
      console.log(
        `Imported ${padsToImport.length} pad configurations from impamp2 data.`,
      );
    }

    console.log(
      `Successfully completed impamp2 profile import. New profile ID: ${profileId}`,
    );
    return profileId;
  } catch (error) {
    console.error(
      "Critical error during impamp2 profile import process:",
      error,
    );
    // Attempt cleanup if profile was created
    if (profileId !== undefined) {
      console.warn(
        `Attempting to delete partially imported impamp2 profile ID: ${profileId}`,
      );
      try {
        await deleteProfile(profileId); // Use the DB utility function
        console.log(
          `Cleaned up partially imported impamp2 profile ID: ${profileId}`,
        );
      } catch (cleanupError) {
        console.error(
          `Failed to clean up partially imported impamp2 profile ID: ${profileId}`,
          cleanupError,
        );
      }
    }
    throw error; // Re-throw the original error
  }
}
