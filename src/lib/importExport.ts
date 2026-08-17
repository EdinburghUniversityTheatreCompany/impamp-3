import { IDBPDatabase } from "idb";
import {
  AudioFile,
  AudioLocation,
  Profile,
  PadConfiguration,
  DEFAULT_PLAYBACK_TYPE,
  PageMetadata,
  SyncType,
  ImpAmpDBSchema,
  getAudioFile,
  getProfile,
  getAllPageMetadataForProfile,
  deleteProfile, // Needed for cleanup in importImpamp2Profile error handling
  deleteUnreferencedAudioFiles,
  collectReferencedAudioFileIds,
  initialSyncFields,
} from "./db"; // Import necessary types and DB functions from db.ts
import type { LoudnessAnalysis } from "./db";
import { getPadIndexForKey } from "./keyboardUtils";
import type { ProfileSyncData } from "./syncUtils";
import { LOUDNESS_ALGO_VERSION } from "./audio/loudness/constants";
import { toWireProfile } from "./profileWire";
import { fetchWithTimeout } from "./fetchWithTimeout";

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
    /** Absent when the file has not been analysed yet. */
    loudness?: SerialisedLoudness;
  }[];
}

// --- Multi-Profile Export/Import ---
export interface MultiProfileExport {
  exportVersion: number; // e.g., 1 for this multi-export format
  exportDate: string;
  profiles: ProfileExport[]; // An array of individual profile exports
}

// --- Loudness analysis serialisation ---
//
// LoudnessAnalysis carries two Float32Arrays, which are not JSON-safe, so
// exports base64-encode them. Exports are ZIP archives that already carry
// the audio itself, so a few KB of manifest per file is negligible against
// the payload — and it saves the importing device a full re-analysis sweep.

export interface SerialisedLoudness {
  algoVersion: number;
  sampleRate: number;
  duration: number;
  /** base64 of the Float32Array buffer. */
  blockMeanSquare: string;
  /** base64 of the Float32Array buffer. */
  hopTruePeak: string;
}

function floatsToBase64(values: Float32Array): string {
  // A Float32Array's buffer may be a view into a larger ArrayBuffer with a
  // non-zero byteOffset (e.g. a slice of another typed array's backing
  // store), so byteOffset/byteLength must be respected rather than encoding
  // values.buffer directly.
  const bytes = new Uint8Array(
    values.buffer,
    values.byteOffset,
    values.byteLength,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToFloats(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function serialiseLoudness(
  analysis: LoudnessAnalysis,
): SerialisedLoudness {
  return {
    algoVersion: analysis.algoVersion,
    sampleRate: analysis.sampleRate,
    duration: analysis.duration,
    blockMeanSquare: floatsToBase64(analysis.blockMeanSquare),
    hopTruePeak: floatsToBase64(analysis.hopTruePeak),
  };
}

/**
 * Restores an exported analysis.
 *
 * Returns null when the analysis came from a different algorithm version or
 * cannot be decoded — the file is then queued for local backfill. Accepting a
 * stale measurement would produce confidently wrong levels, which is worse
 * than having none.
 */
export function deserialiseLoudness(
  serialised: SerialisedLoudness | undefined,
): LoudnessAnalysis | null {
  if (!serialised) return null;
  if (serialised.algoVersion !== LOUDNESS_ALGO_VERSION) return null;

  try {
    return {
      algoVersion: serialised.algoVersion,
      sampleRate: serialised.sampleRate,
      duration: serialised.duration,
      blockMeanSquare: base64ToFloats(serialised.blockMeanSquare),
      hopTruePeak: base64ToFloats(serialised.hopTruePeak),
    };
  } catch {
    return null;
  }
}

// Note: blobToBase64 is intentionally gone — nothing in the app encodes
// audio to base64 anymore. Audio travels as blobs/original files everywhere
// (ZIP archives, IndexedDB, separate Drive files). base64ToBlob below is
// decode-only support for reading legacy formats (old JSON exports, impamp2
// files, and legacy Drive sync data).

// Helper function to convert Base64 string to Blob
export async function base64ToBlob(
  base64: string,
  type: string,
): Promise<Blob> {
  // fetch() decodes data URLs natively and streams the result, which is far
  // faster and lighter on memory than a manual atob() loop for large files.
  try {
    const response = await fetchWithTimeout(
      `data:${type || "application/octet-stream"};base64,${base64}`,
    );
    return await response.blob();
  } catch {
    // Fall back to manual decoding (e.g. if the data URL is rejected)
  }

  try {
    const byteCharacters = atob(base64);
    const byteArrays = [];

    // Decode in chunks to avoid one huge intermediate allocation
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < byteCharacters.length; offset += chunkSize) {
      const slice = byteCharacters.slice(offset, offset + chunkSize);
      const byteArray = new Uint8Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteArray[i] = slice.charCodeAt(i);
      }
      byteArrays.push(byteArray);
    }

    return new Blob(byteArrays, { type });
  } catch (error) {
    console.error("Error converting base64 to Blob:", error);
    throw error;
  }
}

// Helper function to get all pad configurations for a profile (used by ZIP export)
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

// Note: the old base64/JSON export path (exportProfile /
// exportMultipleProfiles) was removed — exports are ZIP-only now
// (exportProfilesToZip below). Importing legacy JSON files is still
// supported for backward compatibility.

// --- Profile Import Logic ---

/**
 * Where an imported profile should sync, decided by the caller.
 *
 * Only the flows that genuinely connect a profile to somewhere — the Drive
 * "Open with" page, the Drive picker, a server share link — pass one. A plain
 * file import passes nothing and gets a local, unlinked profile.
 */
/**
 * Fetches the bytes of a server-hosted sound.
 *
 * A callback rather than a direct call into `serverAudio/` so this module stays
 * ignorant of share tokens and server profile ids — the same shape
 * `downloadAudioBlob` already uses for Drive. The caller
 * (`useConnectServerProfile`) is the one holding those.
 */
export type HostedAudioDownloader = (ref: {
  hash: string;
  name: string;
  type: string;
}) => Promise<Blob>;

export interface ImportLink {
  syncType?: SyncType;
  audioLocation?: AudioLocation | null;
  googleDriveFileId?: string | null;
  googleDriveFolderId?: string | null;
}

/**
 * The fields a newly imported profile starts life with.
 *
 * An import must never inherit where the *donor* profile synced. It used to:
 * `syncType`, `googleDriveFileId` and `googleDriveFolderId` were copied
 * straight out of the incoming data. For a server share link that produced a
 * profile marked `server` while holding the owner's Drive ids, which is how a
 * collaborator ended up trying to write into someone else's Drive folder. For
 * an ordinary file import it produced a second local profile syncing to the
 * same Drive file as the first, and the two then fought.
 *
 * Pure, so the rule can be tested without a database.
 */
export function buildImportedProfileFields(
  donor: Partial<Profile>,
  profileName: string,
  now: Date,
  backupReminderDefault: number,
  link: ImportLink = {},
): Omit<Profile, "id"> {
  return {
    name: profileName,
    syncType: link.syncType ?? "local",
    audioLocation: link.audioLocation ?? null,
    googleDriveFileId: link.googleDriveFileId ?? null,
    googleDriveFolderId: link.googleDriveFolderId ?? null,
    activePadBehavior: donor.activePadBehavior,
    // Following is a decision about this device, never inherited.
    followOnly: false,
    normalisation: donor.normalisation,
    // Importing is not backing up, but it does mean a copy exists elsewhere,
    // so the clock starts now rather than at the donor's last backup.
    lastBackedUpAt: now.getTime(),
    backupReminderPeriod: donor.backupReminderPeriod ?? backupReminderDefault,
    createdAt: now,
    updatedAt: now,
  };
}

// Helper function to create a new profile for import, handling name conflicts
async function createImportedProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  exportData: ProfileExport | { profile: Partial<Profile> & { name: string } }, // Allow partial for impamp2
  now: Date,
  link: ImportLink = {},
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

  const newProfileData = buildImportedProfileFields(
    exportData.profile as Partial<Profile>,
    profileName,
    now,
    DEFAULT_BACKUP_REMINDER_PERIOD_MS,
    link,
  );

  const profileId = await profileStore.add(newProfileData);
  await profileTx.done;

  return profileId;
}

/**
 * A pluggable source for one audio file during import. The blob is only
 * materialized when getBlob() is called, so callers can stream files one at a
 * time (from a ZIP entry, a base64 string, etc.) instead of holding the whole
 * archive in memory.
 */
export interface ImportAudioSource {
  originalId: number;
  name: string;
  type: string;
  /** Uncompressed size in bytes, if known (used for progress reporting). */
  size?: number;
  /**
   * Materializes the audio blob. Sources that can report progress mid-file
   * (e.g. ZIP extraction) invoke onBytes with the number of bytes done so far.
   */
  getBlob: (onBytes?: (bytesDone: number) => void) => Promise<Blob>;
  /** Carried analysis, if the exporting device had one. */
  loudness?: SerialisedLoudness;
  /**
   * The content hash, when the source already knows it.
   *
   * Worth carrying rather than recomputing: without it the record lands
   * hashless, and the next sync that needs a hash reads and SHA-256s *every*
   * audio file in the library one blob at a time to build a fallback index.
   */
  hash?: string;
  /** Set when these bytes came from the app's own object store. */
  serverHosted?: boolean;
}

/** One audio file the import could not write, and why. */
interface AudioImportFailure {
  name: string;
  error: unknown;
}

/** What `importAudioSources` managed to write, and what it did not. */
interface AudioImportOutcome {
  /** Original export id → the id the local store assigned. */
  audioIdMap: Map<number, number>;
  failures: AudioImportFailure[];
}

/**
 * The browser's "you have filled your storage" error.
 *
 * It arrives as a DOMException from the write, or from anything upstream that
 * had to allocate, and it is the one import failure that retrying unchanged
 * cannot fix — so it earns a message of its own rather than being folded into
 * the generic count.
 */
function isQuotaExceededError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

/**
 * Turns collected audio failures into the message the user is shown.
 *
 * Named files rather than a bare count, because the answer to "which sounds
 * are missing?" is the whole point of failing loudly here.
 */
function describeAudioImportFailures(
  failures: AudioImportFailure[],
  total: number,
): string {
  const named = failures
    .slice(0, 3)
    .map((f) => f.name)
    .join("; ");
  const ellipsis = failures.length > 3 ? "; …" : "";
  const detail = `${failures.length} of ${total} sound${total === 1 ? "" : "s"} could not be imported (${named}${ellipsis}).`;

  if (failures.some((f) => isQuotaExceededError(f.error))) {
    return `${detail} This device has run out of storage space, so importing again will fail the same way — free some up (deleting an unused profile, or clearing other sites' data) first.`;
  }
  return detail;
}

/** Progress information reported while importing audio files. */
export interface ImportAudioProgress {
  fileName: string;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
}

// Imports audio files with bounded memory: each file is materialized,
// written in a short transaction, then released — memory stays bounded by
// `concurrency` files at once rather than the whole export.
//
// concurrency = 1 (default) also enables byte-level progress within each
// file. Higher values run sources through a small worker pool — useful for
// latency-bound sources like Google Drive downloads, pointless for local
// ZIP extraction — reporting per-file completion progress instead (bytes
// from interleaved files would not be meaningful).
async function importAudioSources(
  db: IDBPDatabase<ImpAmpDBSchema>,
  audioSources: ImportAudioSource[],
  now: Date,
  onProgress?: (progress: ImportAudioProgress) => void,
  concurrency = 1,
): Promise<AudioImportOutcome> {
  const audioIdMap = new Map<number, number>();
  const failures: AudioImportFailure[] = [];
  const totalBytes = audioSources.reduce((sum, s) => sum + (s.size ?? 0), 0);
  let processedBytes = 0;
  let completedFiles = 0;

  console.log(
    `Starting import of ${audioSources.length} audio files (concurrency: ${concurrency})`,
  );

  const importOne = async (
    source: ImportAudioSource,
    reportBytes: boolean,
  ): Promise<void> => {
    try {
      const blob = await source.getBlob(
        reportBytes
          ? (bytesDone) => {
              onProgress?.({
                fileName: source.name,
                processedFiles: completedFiles,
                totalFiles: audioSources.length,
                processedBytes: processedBytes + bytesDone,
                totalBytes,
              });
            }
          : undefined,
      );
      const audioTx = db.transaction("audioFiles", "readwrite");
      const newAudioId = await audioTx.objectStore("audioFiles").add({
        blob,
        name: source.name,
        type: source.type,
        createdAt: now,
        loudness: deserialiseLoudness(source.loudness) ?? undefined,
        hash: source.hash,
        serverHosted: source.serverHosted,
      });
      await audioTx.done;
      audioIdMap.set(source.originalId, newAudioId);
    } catch (error) {
      // Collected rather than swallowed, for the same reason the pad and page
      // importers collect theirs: the failed id never reaches `audioIdMap`, so
      // the pad naming it lands one sound short and the import used to report
      // success anyway. The remaining files are still attempted, so the
      // message can name all of them at once instead of one per retry.
      console.error(
        `Failed to import audio file: ${source.name} (Original ID: ${source.originalId})`,
        error,
      );
      failures.push({ name: source.name, error });
    }
    completedFiles++;
    processedBytes += source.size ?? 0;
    onProgress?.({
      fileName: source.name,
      processedFiles: completedFiles,
      totalFiles: audioSources.length,
      processedBytes,
      totalBytes,
    });
  };

  if (concurrency <= 1) {
    for (const source of audioSources) {
      await importOne(source, true);
    }
  } else {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, audioSources.length) },
      async () => {
        while (nextIndex < audioSources.length) {
          const source = audioSources[nextIndex++];
          await importOne(source, false);
        }
      },
    );
    await Promise.all(workers);
  }

  console.log(`Completed audio file import, mapped ${audioIdMap.size} files`);
  return { audioIdMap, failures };
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
  const failures: number[] = [];

  const pagePromises = pageMetadata.map((page) => {
    const content = {
      profileId,
      pageIndex: page.pageIndex,
      name: page.name,
      isEmergency: page.isEmergency,
    };
    const newMetadata = {
      ...content,
      createdAt: now,
      // As for pads: without these the merge has nothing to compare on.
      ...initialSyncFields(content, now.getTime()),
      updatedAt: now,
    };
    return pageStore.add(newMetadata).catch((err: unknown) => {
      console.error(
        `Failed to add page metadata for pageIndex ${page.pageIndex}:`,
        err,
      );
      failures.push(page.pageIndex);
    });
  });

  try {
    await Promise.all(pagePromises);
    await pageTx.done;
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} bank${failures.length === 1 ? "" : "s"} could not be imported (${failures.map((i) => i + 1).join(", ")}).`,
      );
    }
    console.log(`Imported ${pageMetadata.length} page metadata entries.`);
  } catch (txError) {
    console.error("Error during page metadata import transaction:", txError);
    throw txError; // Re-throw transaction error
  }
}

/**
 * Translates a record keyed by audio file ID through an old-id to new-id map.
 *
 * Audio file IDs are reassigned on import and on sync, so every
 * Record<audioFileId, …> field on a pad must go through this.
 *
 * `unmappedKeys` is explicit because the call sites genuinely differ:
 * the import and Drive paths drop an entry whose ID has no mapping, while
 * the sync-merge path keeps it under its original ID. Passing the wrong one
 * changes behaviour silently, so there is no default.
 */
export function remapAudioFileIdKeys<T>(
  settings: Record<number, T> | undefined,
  idMap: Map<number, number>,
  unmappedKeys: "drop" | "keep",
): Record<number, T> | undefined {
  if (!settings) return undefined;

  const result: Record<number, T> = {};
  for (const [oldIdStr, value] of Object.entries(settings)) {
    const oldId = Number(oldIdStr);
    const newId = idMap.get(oldId);
    if (newId !== undefined) {
      result[newId] = value;
    } else if (unmappedKeys === "keep") {
      result[oldId] = value;
    }
  }
  return result;
}

/**
 * Remaps a pad's audio-file-keyed settings for the import and Drive-sync
 * paths, where an ID with no mapping means the referenced audio did not come
 * across — so the setting is dropped rather than left pointing at nothing.
 */
export function remapPadSettingsOnImport<T>(
  settings: Record<number, T> | undefined,
  idMap: Map<number, number>,
): Record<number, T> | undefined {
  return remapAudioFileIdKeys(settings, idMap, "drop");
}

/**
 * Remaps a pad's audio-file-keyed settings for the sync-merge path, where an
 * unmapped ID is a file that simply has no local counterpart yet — so the
 * setting is kept under its original ID to survive under whatever eventually
 * resolves it.
 */
export function remapPadSettingsOnMerge<T>(
  settings: Record<number, T> | undefined,
  idMap: Map<number, number>,
): Record<number, T> | undefined {
  return remapAudioFileIdKeys(settings, idMap, "keep");
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
  const failures: string[] = [];

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

    // Map audioTrimSettings and audioGainSettings keys (old audioFileId ->
    // new audioFileId). An ID with no mapping is dropped: it addresses audio
    // that was not (or could not be) imported, so keeping it would leave a
    // setting pointing at nothing.
    const mappedTrimSettings = remapPadSettingsOnImport(
      pad.audioTrimSettings,
      audioIdMap,
    );
    const mappedGainSettings = remapPadSettingsOnImport(
      pad.audioGainSettings,
      audioIdMap,
    );

    // Construct the new pad configuration using the updated structure
    const newPadData: Omit<PadConfiguration, "id"> = {
      profileId,
      padIndex: pad.padIndex,
      pageIndex: pad.pageIndex,
      keyBinding: pad.keyBinding,
      name: pad.name,
      audioFileIds: mappedAudioFileIds, // Use the mapped array
      audioTrimSettings: mappedTrimSettings,
      audioGainSettings: mappedGainSettings,
      padGainDb: pad.padGainDb, // Whole-pad gain isn't keyed by audio file ID
      playbackType: pad.playbackType || DEFAULT_PLAYBACK_TYPE,
      isDisabled: pad.isDisabled ?? false, // Absent in exports predating the flag
      createdAt: now,
      // Sync bookkeeping, which these records used to be written without. It
      // is the entire basis `compareSyncableItems` decides a merge on, so an
      // imported pad looked to the merge like it had never been touched — and
      // the first sync after an import could prefer a remote copy over sounds
      // the user had just imported.
      ...initialSyncFields(
        { ...pad, profileId, audioFileIds: mappedAudioFileIds },
        now.getTime(),
      ),
      updatedAt: now,
    };

    return padStore.add(newPadData).catch((err: unknown) => {
      // Collected rather than swallowed. This used to log and carry on, and
      // the import then reported success — so a board came back missing pads
      // and said nothing, which is discovered mid-show.
      console.error(
        `Failed to add pad configuration for pageIndex ${pad.pageIndex}, padIndex ${pad.padIndex}:`,
        err,
      );
      failures.push(`bank ${pad.pageIndex + 1}, pad ${pad.padIndex + 1}`);
    });
  });

  try {
    await Promise.all(padPromises);
    await padTx.done;
    if (failures.length > 0) {
      // `importProfileCore` deletes the partial profile when this throws, so
      // the user gets a clear failure and an intact library rather than a
      // board with holes in it.
      throw new Error(
        `${failures.length} of ${padConfigurations.length} pads could not be imported (${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; …" : ""}).`,
      );
    }
    console.log(`Imported ${padConfigurations.length} pad configurations.`);
  } catch (txError) {
    console.error(
      "Error during pad configuration import transaction:",
      txError,
    );
    throw txError; // Re-throw transaction error
  }
}

// Shared metadata shape for imports: a full ProfileExport minus the audio
// payload (audio arrives separately via ImportAudioSource[]).
type ProfileImportMeta = Omit<ProfileExport, "audioFiles">;

/**
 * Core import routine shared by the JSON and ZIP paths. Creates the profile,
 * imports audio from the provided sources (one file at a time), then imports
 * page metadata and pad configurations. Cleans up the partial profile on
 * failure.
 */
async function importProfileCore(
  db: IDBPDatabase<ImpAmpDBSchema>,
  exportData: ProfileImportMeta,
  audioSources: ImportAudioSource[],
  onAudioProgress?: (progress: ImportAudioProgress) => void,
  audioConcurrency = 1,
  link: ImportLink = {},
): Promise<number> {
  let profileId: number | undefined = undefined;
  // Every audio record this import created, so the failure path can take them
  // back out. `deleteProfile` alone cannot: it derives what to delete from the
  // profile's pads, and audio is written two steps before those exist.
  const createdAudioIds: number[] = [];
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
          playbackType: DEFAULT_PLAYBACK_TYPE, // V1 pads predate the field
          createdAt: oldPad.createdAt || now, // Use existing or new date
          updatedAt: oldPad.updatedAt || now, // Use existing or new date
        };
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
    profileId = await createImportedProfile(db, exportData, now, link);
    console.log(`Created imported profile with ID ${profileId}`);

    // Step 2: Import audio files (one short transaction per file)
    const { audioIdMap, failures: audioFailures } = await importAudioSources(
      db,
      audioSources,
      now,
      onAudioProgress,
      audioConcurrency,
    );
    createdAudioIds.push(...audioIdMap.values());
    console.log(`Imported ${audioIdMap.size} audio files`);

    if (audioFailures.length > 0) {
      // Same rule as the pad importer: a sound that did not arrive is a failed
      // import, not a successful one with a quieter board. Throwing here also
      // removes the partial profile, so the user is never left with pads that
      // look assigned and do nothing.
      throw new Error(
        describeAudioImportFailures(audioFailures, audioSources.length),
      );
    }

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

    // The audio above went straight into the `audioFiles` store via a raw
    // transaction (see importAudioSources), not through `addAudioFile`, so
    // none of it triggered `analyseAndStore` the way a drag-and-drop
    // assignment does. `refreshProfileLoudness` is the usual fire-and-forget
    // trigger for this, but it isn't right here: `createImportedProfile`
    // always allocates a fresh id, so this profile is never the one active
    // in the store at this point, and `loadProfileLoudness` (which
    // `refreshProfileLoudness` calls) replaces the *entire* in-memory gain
    // cache with whatever profile it's given — calling it for a profile that
    // isn't active would clobber the cache for the profile the user actually
    // has open (see the same guard in applySyncedProfile.ts). `runBackfill`
    // alone is safe for any caller: it's a global, additive sweep that
    // persists measurements to IndexedDB and only adds to the in-memory
    // cache, never replaces it. So importing sounds now starts the same
    // background analysis a fresh install gets, instead of leaving every
    // imported file at 0 dB until the user switches into this profile, hits
    // re-analyse, or reloads. Dynamic import keeps the Web-Audio-only
    // pipeline out of every caller of importExport.ts; fire-and-forget since
    // the import itself must not sit through a full-board decode.
    void import("./audio/loudness/pipeline")
      .then(({ runBackfill }) => runBackfill())
      .catch((error) => {
        console.warn(
          `[Loudness] Post-import backfill failed (profile ${profileId}):`,
          error,
        );
      });

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

    // And the audio, which the profile delete above could not reach: it
    // decides what to remove from the profile's pads, and a failure between
    // step 2 and step 4 means those pads were never written. Whatever the
    // surviving pads do still name is kept, so this can never take a sound
    // out from under another profile.
    if (createdAudioIds.length > 0) {
      try {
        const removed = await deleteUnreferencedAudioFiles(createdAudioIds);
        console.log(
          `Cleaned up ${removed} of ${createdAudioIds.length} audio files written by the failed import.`,
        );
      } catch (cleanupError) {
        console.error(
          "Failed to clean up audio files from the failed import:",
          cleanupError,
        );
      }
    }
    throw error; // Re-throw the original import error
  }
}

// Import a profile from a standard export object (base64-encoded audio)
export async function importProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  exportData: ProfileExport,
): Promise<number> {
  const audioSources: ImportAudioSource[] = exportData.audioFiles.map(
    (audioFileExport) => ({
      originalId: audioFileExport.id,
      name: audioFileExport.name,
      type: audioFileExport.type,
      loudness: audioFileExport.loudness,
      getBlob: () => base64ToBlob(audioFileExport.data, audioFileExport.type),
    }),
  );

  return importProfileCore(db, exportData, audioSources);
}

// Number of Google Drive audio downloads to run concurrently when
// connecting a synced profile. Drive requests are latency-dominated, so a
// small pool gives a large speedup on many-file profiles without straining
// API rate limits or memory (at most this many files are in flight).
const DRIVE_DOWNLOAD_CONCURRENCY = 4;

/**
 * Imports a profile directly from Google Drive sync data, streaming each
 * audio file (downloaded blob, or legacy embedded base64) straight into
 * IndexedDB, downloading a few files concurrently.
 *
 * This replaces the old connect flow that base64-encoded every downloaded
 * blob and round-tripped the whole profile through one giant JSON string —
 * which held all audio in memory at once and hit V8's ~512 MB string cap
 * for large profiles.
 *
 * The caller links the imported profile to Drive (file/folder IDs,
 * read-only flag) using the returned profile ID.
 *
 * @param downloadAudioBlob Downloads the blob for a driveFileId (typically
 *   useGoogleDriveSync().downloadAudioFile).
 */
export async function importProfileFromSyncData(
  db: IDBPDatabase<ImpAmpDBSchema>,
  syncData: ProfileSyncData,
  downloadAudioBlob: (driveFileId: string) => Promise<Blob | null>,
  onProgress?: (progress: ImportAudioProgress) => void,
  link: ImportLink = {},
  downloadHostedBlob?: HostedAudioDownloader,
): Promise<number> {
  // Strip fields the import must not carry over (a fresh id is assigned and
  // lastBackedUpAt is stamped by the import itself).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, lastBackedUpAt, ...profileRest } = syncData.profile;

  const meta: ProfileImportMeta = {
    exportVersion: 2,
    exportDate: new Date().toISOString(),
    // Content only. Where the new profile syncs comes from `link`, never from
    // the donor — see buildImportedProfileFields.
    profile: profileRest,
    padConfigurations: syncData.padConfigurations ?? [],
    pageMetadata: syncData.pageMetadata ?? [],
  };

  const audioSources: ImportAudioSource[] = [];
  for (const ref of syncData.audioFiles ?? []) {
    if (ref.driveFileId) {
      const driveFileId = ref.driveFileId;
      audioSources.push({
        originalId: ref.id,
        name: ref.name,
        type: ref.type,
        getBlob: async () => {
          const blob = await downloadAudioBlob(driveFileId);
          if (!blob) {
            throw new Error(
              `Failed to download audio "${ref.name}" from Google Drive.`,
            );
          }
          return blob;
        },
      });
    } else if (typeof ref.data === "string") {
      // Legacy sync format: audio embedded as base64
      const data = ref.data;
      audioSources.push({
        originalId: ref.id,
        name: ref.name,
        type: ref.type,
        getBlob: () => base64ToBlob(data, ref.type),
      });
    } else if (ref.serverHosted && ref.hash && downloadHostedBlob) {
      // Hosted by this app's own server: no Drive file, no embedded bytes,
      // just a content hash to fetch by. Skipping these is what made joining
      // a share link on an S3-configured deployment import empty pads.
      const hash = ref.hash;
      audioSources.push({
        originalId: ref.id,
        name: ref.name,
        type: ref.type,
        hash,
        serverHosted: true,
        getBlob: () =>
          downloadHostedBlob({ hash, name: ref.name, type: ref.type }),
      });
    } else {
      console.warn(
        `Audio file "${ref.name}" (ID ${ref.id}) has ${
          ref.serverHosted && ref.hash
            ? "hosted audio but no downloader was supplied"
            : "neither driveFileId nor embedded data"
        } — skipping.`,
      );
    }
  }

  // Drive downloads are latency-bound (many small HTTP requests), so a
  // small worker pool speeds up connects considerably. Kept modest to stay
  // well within Drive API rate limits.
  return importProfileCore(
    db,
    meta,
    audioSources,
    onProgress,
    DRIVE_DOWNLOAD_CONCURRENCY,
    link,
  );
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
            playbackType: DEFAULT_PLAYBACK_TYPE,
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
          playbackType: DEFAULT_PLAYBACK_TYPE, // impamp2 files predate the field
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

// --- ZIP Export/Import ---

export interface AudioFileRef {
  id: number;
  name: string;
  type: string;
  /** Absent when the file has not been analysed yet. */
  loudness?: SerialisedLoudness;
  /**
   * The content hash, when the exporting device had computed one.
   *
   * Additive, so archives written before this simply carry none and import
   * exactly as they did. Worth carrying: a record that lands hashless makes
   * the next sync that needs a hash read and SHA-256 *every* audio file in the
   * library, one blob at a time, to build a fallback index — so restoring a
   * large library used to guarantee that sweep.
   */
  hash?: string;
}

export interface ProfileExportLean {
  exportVersion: 2;
  exportDate: string;
  profile: Omit<Profile, "lastBackedUpAt"> & { id?: number };
  padConfigurations: PadConfiguration[];
  pageMetadata: PageMetadata[];
  audioFiles: AudioFileRef[]; // no base64 data — audio stored as separate files in ZIP
}

export interface ZipManifest {
  exportVersion: 3;
  exportDate: string;
  profiles: { name: string; folder: string }[];
}

/**
 * Collects profile data without converting audio to base64.
 * Returns lean profile data plus a map of audioFileId → Blob for ZIP storage.
 */
async function collectProfileDataForZip(profileId: number): Promise<{
  lean: ProfileExportLean;
  audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
}> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw new Error(`Profile with ID ${profileId} not found`);
  }

  const padConfigurations = await getAllPadConfigurationsForProfile(profileId);
  const pageMetadata = await getAllPageMetadataForProfile(profileId);

  const audioFileIds = collectReferencedAudioFileIds(padConfigurations);

  const audioFiles: AudioFileRef[] = [];
  const audioBlobs = new Map<
    number,
    { blob: Blob; name: string; type: string }
  >();

  for (const audioFileId of audioFileIds) {
    const audioFile = await getAudioFile(audioFileId);
    if (audioFile) {
      audioFiles.push({
        id: audioFileId,
        name: audioFile.name,
        type: audioFile.type,
        loudness: audioFile.loudness
          ? serialiseLoudness(audioFile.loudness)
          : undefined,
        hash: audioFile.hash,
      });
      audioBlobs.set(audioFileId, {
        blob: audioFile.blob,
        name: audioFile.name,
        type: audioFile.type,
      });
    } else {
      console.warn(
        `Audio file ID ${audioFileId} referenced but not found in DB.`,
      );
    }
  }

  // Sync carries `lastBackedUpAt`; an export must not. Importing this file
  // stamps its own, and inheriting the donor's would claim a backup the
  // importing device never made.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { lastBackedUpAt, ...profileToExport } = toWireProfile(profile);

  const lean: ProfileExportLean = {
    exportVersion: 2,
    exportDate: new Date().toISOString(),
    profile: profileToExport,
    padConfigurations,
    pageMetadata,
    audioFiles,
  };

  return { lean, audioBlobs };
}

/**
 * Progress reported while exporting to or importing from a ZIP archive.
 * Byte counts cover audio data only (metadata is negligible in comparison).
 */
export interface TransferProgress {
  phase: "preparing" | "audio" | "finalizing";
  fileName?: string;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
}

export type TransferProgressCallback = (progress: TransferProgress) => void;

// Loads zip.js lazily and disables its web workers: they complicate bundling
// under Next.js and buy nothing here since audio entries are STOREd
// (no compression work to offload).
async function getZipJs() {
  const zipjs = await import("@zip.js/zip.js");
  zipjs.configure({ useWebWorkers: false });
  return zipjs;
}

/**
 * Exports profiles as a ZIP archive (.iaz), streaming each audio blob
 * straight into the target so the archive never has to fit in memory.
 * Structure: manifest.json + audio/<id> (shared) + profiles/<n>/profile.json
 *
 * @param profileIds Profiles to include.
 * @param target A WritableStream (e.g. from showSaveFilePicker) to stream the
 *   archive to disk, or "blob" to build an in-memory Blob (fallback for
 *   browsers without the File System Access API).
 * @returns The archive Blob when target is "blob", otherwise null.
 */
export async function exportProfilesToZip(
  profileIds: number[],
  target: WritableStream | "blob",
  onProgress?: TransferProgressCallback,
): Promise<Blob | null> {
  const zipjs = await getZipJs();

  onProgress?.({
    phase: "preparing",
    processedFiles: 0,
    totalFiles: 0,
    processedBytes: 0,
    totalBytes: 0,
  });

  // Collect metadata for all profiles first. The audio blobs pulled from
  // IndexedDB are references (Chrome keeps large blobs on disk), so holding
  // them in a map is cheap — the data itself is only read while streaming.
  const manifestProfiles: { name: string; folder: string }[] = [];
  const profileJsonEntries: { path: string; json: string }[] = [];
  const allAudioBlobs = new Map<
    number,
    { blob: Blob; name: string; type: string }
  >();

  for (let i = 0; i < profileIds.length; i++) {
    try {
      const { lean, audioBlobs } = await collectProfileDataForZip(
        profileIds[i],
      );
      const folder = String(i);
      manifestProfiles.push({ name: lean.profile.name, folder });
      profileJsonEntries.push({
        path: `profiles/${folder}/profile.json`,
        json: JSON.stringify(lean, null, 2),
      });
      for (const [id, data] of audioBlobs) {
        if (!allAudioBlobs.has(id)) {
          allAudioBlobs.set(id, data);
        }
      }
    } catch (error) {
      console.warn(`Failed to export profile ID ${profileIds[i]}:`, error);
    }
  }

  const totalFiles = allAudioBlobs.size;
  let totalBytes = 0;
  for (const { blob } of allAudioBlobs.values()) {
    totalBytes += blob.size;
  }

  const blobWriter =
    target === "blob" ? new zipjs.BlobWriter("application/zip") : null;
  const zipWriter = new zipjs.ZipWriter(
    blobWriter ?? (target as WritableStream),
  );

  const manifest: ZipManifest = {
    exportVersion: 3,
    exportDate: new Date().toISOString(),
    profiles: manifestProfiles,
  };
  // JSON metadata compresses well — DEFLATE it.
  await zipWriter.add(
    "manifest.json",
    new zipjs.TextReader(JSON.stringify(manifest, null, 2)),
    { level: 6 },
  );
  for (const { path, json } of profileJsonEntries) {
    await zipWriter.add(path, new zipjs.TextReader(json), { level: 6 });
  }

  let processedFiles = 0;
  let processedBytes = 0;
  for (const [id, { blob, name }] of allAudioBlobs) {
    onProgress?.({
      phase: "audio",
      fileName: name,
      processedFiles,
      totalFiles,
      processedBytes,
      totalBytes,
    });
    // Audio formats are already compressed — STORE them instead of wasting
    // time (and blocking the UI) on DEFLATE that saves next to nothing.
    await zipWriter.add(`audio/${id}`, new zipjs.BlobReader(blob), {
      level: 0,
      onprogress: async (progress: number) => {
        onProgress?.({
          phase: "audio",
          fileName: name,
          processedFiles,
          totalFiles,
          processedBytes: processedBytes + progress,
          totalBytes,
        });
      },
    });
    processedFiles++;
    processedBytes += blob.size;
  }

  onProgress?.({
    phase: "finalizing",
    processedFiles,
    totalFiles,
    processedBytes,
    totalBytes,
  });
  await zipWriter.close();

  return blobWriter ? blobWriter.getData() : null;
}

export interface ZipImportResult {
  profileName: string;
  result: number | Error;
}

/**
 * Imports profiles from a .iaz ZIP archive. Handles both layouts:
 * multi-profile (manifest.json + profiles/<n>/profile.json) and legacy
 * single-profile (profile.json at the root).
 *
 * Only the ZIP's central directory is loaded upfront; each audio file is
 * extracted from the source Blob on demand and written straight to IndexedDB,
 * so memory use is bounded by the largest single audio file — never the
 * archive size. No base64 conversion is involved.
 */
export async function importProfilesFromZip(
  zipBlob: Blob,
  db: IDBPDatabase<ImpAmpDBSchema>,
  onProgress?: TransferProgressCallback,
): Promise<ZipImportResult[]> {
  const zipjs = await getZipJs();
  const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(zipBlob));

  try {
    onProgress?.({
      phase: "preparing",
      processedFiles: 0,
      totalFiles: 0,
      processedBytes: 0,
      totalBytes: 0,
    });

    const entries = await zipReader.getEntries();
    const entryByName = new Map(entries.map((e) => [e.filename, e]));

    // A metadata entry is read into a single string, so its *uncompressed*
    // size is what matters, not the archive's. Without this an archive of a
    // few hundred kilobytes could name a manifest that expands to gigabytes
    // and take the tab out before anything was validated — the JSON import
    // path has had a cap all along, the ZIP path had none.
    const readEntryText = async (name: string): Promise<string | null> => {
      const entry = entryByName.get(name);
      if (!entry || entry.directory) return null;

      const size = entry.uncompressedSize ?? 0;
      if (size > MAX_ZIP_METADATA_BYTES) {
        throw new Error(
          `The entry ${name} in this archive is implausibly large (${Math.round(size / 1024 / 1024)} MB) and was not read.`,
        );
      }

      return entry.getData(new zipjs.TextWriter());
    };

    /**
     * Parses a metadata entry, saying which entry failed rather than throwing
     * a bare SyntaxError from somewhere inside the archive.
     */
    const parseEntryJson = (name: string, text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${name} in this archive is not valid JSON.`);
      }
    };

    // Determine the archive layout and gather the lean profile descriptors
    const results: ZipImportResult[] = [];
    const leanProfiles: ProfileExportLean[] = [];

    const manifestText = await readEntryText("manifest.json");
    if (manifestText) {
      const manifest = parseEntryJson(
        "manifest.json",
        manifestText,
      ) as ZipManifest;
      if (manifest.exportVersion !== 3 || !Array.isArray(manifest.profiles)) {
        throw new Error("Invalid or unsupported multi-profile ZIP format.");
      }
      for (const entry of manifest.profiles) {
        const text = await readEntryText(
          `profiles/${entry.folder}/profile.json`,
        );
        if (!text) {
          results.push({
            profileName: entry.name,
            result: new Error(`Missing profiles/${entry.folder}/profile.json`),
          });
          continue;
        }
        leanProfiles.push(
          asLeanProfile(
            parseEntryJson(`profiles/${entry.folder}/profile.json`, text),
            `profiles/${entry.folder}/profile.json`,
          ),
        );
      }
    } else {
      const singleText = await readEntryText("profile.json");
      if (!singleText) {
        throw new Error(
          "Invalid .iaz file: missing manifest.json or profile.json",
        );
      }
      leanProfiles.push(
        asLeanProfile(
          parseEntryJson("profile.json", singleText),
          "profile.json",
        ),
      );
    }

    // Aggregate totals across all profiles for one smooth progress bar
    const entrySize = (ref: AudioFileRef): number =>
      entryByName.get(`audio/${ref.id}`)?.uncompressedSize ?? 0;
    const totalFiles = leanProfiles.reduce(
      (n, lean) => n + lean.audioFiles.length,
      0,
    );
    const totalBytes = leanProfiles.reduce(
      (n, lean) => n + lean.audioFiles.reduce((m, r) => m + entrySize(r), 0),
      0,
    );
    let doneFiles = 0;
    let doneBytes = 0;

    for (const lean of leanProfiles) {
      const profileName = lean.profile?.name || "Unnamed Profile";
      try {
        const audioSources: ImportAudioSource[] = [];
        for (const ref of lean.audioFiles) {
          const entry = entryByName.get(`audio/${ref.id}`);
          if (!entry || entry.directory) {
            console.warn(
              `Audio file ${ref.id} referenced by profile "${profileName}" not found in ZIP.`,
            );
            continue;
          }
          const getData = entry.getData.bind(entry);
          audioSources.push({
            originalId: ref.id,
            name: ref.name,
            type: ref.type,
            size: entry.uncompressedSize,
            loudness: ref.loudness,
            hash: ref.hash,
            getBlob: (onBytes) =>
              getData(new zipjs.BlobWriter(ref.type), {
                onprogress: onBytes
                  ? async (bytesDone: number) => {
                      onBytes(bytesDone);
                    }
                  : undefined,
              }),
          });
        }

        const baseFiles = doneFiles;
        const baseBytes = doneBytes;
        const newProfileId = await importProfileCore(
          db,
          lean,
          audioSources,
          (p) => {
            onProgress?.({
              phase: "audio",
              fileName: p.fileName,
              processedFiles: baseFiles + p.processedFiles,
              totalFiles,
              processedBytes: baseBytes + p.processedBytes,
              totalBytes,
            });
          },
        );
        doneFiles += audioSources.length;
        doneBytes += audioSources.reduce((s, a) => s + (a.size ?? 0), 0);
        results.push({ profileName, result: newProfileId });
      } catch (error) {
        results.push({
          profileName,
          result: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    return results;
  } finally {
    try {
      await zipReader.close();
    } catch {
      // ignore close errors
    }
  }
}

// JSON imports must be read into a single string, and V8 caps strings at
// ~512 MB — larger legacy exports simply cannot be parsed in the browser.
// (.iaz archives have no such limit since they are streamed.)
export const MAX_JSON_IMPORT_BYTES = 480 * 1024 * 1024;

/**
 * The most an *uncompressed* metadata entry inside a `.iaz` may be.
 *
 * The audio entries are streamed and unbounded by design; these are read into
 * strings and parsed, so they need a limit of their own. Generous for a
 * document that holds names, hashes and pad layout for one profile.
 */
export const MAX_ZIP_METADATA_BYTES = 32 * 1024 * 1024;

/**
 * Checks that a parsed archive entry is shaped like a profile before the
 * import starts writing records from it.
 *
 * Deliberately shallow: the fields it does not check are re-derived or
 * allow-listed downstream (`buildImportedProfileFields`), and this exists to
 * turn "TypeError: cannot read properties of undefined" halfway through a
 * partly-written import into a refusal that names the file.
 */
function asLeanProfile(parsed: unknown, entryName: string): ProfileExportLean {
  const value = parsed as Partial<ProfileExportLean> | null;

  if (!value || typeof value !== "object") {
    throw new Error(`${entryName} does not contain a profile.`);
  }
  if (!value.profile || typeof value.profile !== "object") {
    throw new Error(`${entryName} has no profile in it.`);
  }
  for (const field of [
    "padConfigurations",
    "pageMetadata",
    "audioFiles",
  ] as const) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`${entryName} has a malformed ${field} list.`);
    }
  }

  return {
    ...value,
    padConfigurations: value.padConfigurations ?? [],
    pageMetadata: value.pageMetadata ?? [],
    audioFiles: value.audioFiles ?? [],
  } as ProfileExportLean;
}

/**
 * Detects the format of an import file.
 */
export async function detectImportFormat(
  file: File,
): Promise<
  | "zip"
  | "json-v2-single"
  | "json-v1-multi"
  | "impamp2-legacy"
  | "json-too-large"
  | "unknown"
> {
  // Check extension first
  if (file.name.toLowerCase().endsWith(".iaz")) {
    return "zip";
  }

  // Check ZIP magic bytes (PK\x03\x04)
  const header = await file.slice(0, 4).arrayBuffer();
  const bytes = new Uint8Array(header);
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "zip";
  }

  if (file.size > MAX_JSON_IMPORT_BYTES) {
    return "json-too-large";
  }

  // Try JSON parsing
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.exportVersion === 1 && Array.isArray(parsed.profiles))
      return "json-v1-multi";
    if (parsed.exportVersion === 2 && parsed.profile) return "json-v2-single";
    if (
      parsed.pages &&
      typeof parsed.pages === "object" &&
      !parsed.exportVersion
    )
      return "impamp2-legacy";
  } catch {
    // not JSON
  }

  return "unknown";
}
