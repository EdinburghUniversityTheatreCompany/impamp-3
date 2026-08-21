import { openDB, DBSchema, IDBPDatabase, IDBPTransaction } from "idb";
import { loadLoudnessPipeline } from "@/lib/audio/loudness/loadPipeline";
import type {
  LoudnessAnalysis,
  NormalisationSettings,
} from "@/lib/audio/loudness/types";
import { convertIndexToBankNumber } from "./bankUtils";
import {
  migrateToV7,
  migratedBankId,
  type V7Transaction,
} from "./dbMigrations/v7BankId";
import { compareBankOrder, normaliseBankOrder } from "./bankOrder";

export type { LoudnessAnalysis, NormalisationSettings };
export { DEFAULT_NORMALISATION } from "@/lib/audio/loudness/types";

const DB_NAME = "impamp3DB";
const DB_VERSION = 7; // DB version for bank identity (bankId)

// Define the structure of audio file data
export interface AudioFile {
  id?: number;
  blob: Blob;
  name: string;
  type: string;
  hash?: string; // SHA-256 hex digest of blob content
  createdAt: Date;
  driveFileIds?: Record<number, string>; // profileId → Google Drive file ID
  /** BS.1770-4 analysis. Absent until the file has been analysed. */
  loudness?: LoudnessAnalysis;
  /**
   * True once this deployment's object store holds these bytes.
   *
   * Recorded rather than re-derived each sync. It used to be worked out from
   * whatever the current run managed to upload, so any abort — an unapproved
   * account, a full cap, one transient failure — published a blob with the
   * flag stripped from files that really were hosted, and readers were left
   * with no route to the bytes and cleared the pads.
   */
  serverHosted?: boolean;
}

// Define the structure of profile data
export type SyncType = "local" | "googleDrive" | "server";

/**
 * Where a profile publishes its audio for other devices and people.
 *
 * Deliberately separate from `syncType`: the two are independent axes. A
 * server-synced profile has always been able to keep its audio in Drive — the
 * server stores only the blob — and hosting it on the server instead is a
 * gated extra (docs/wasabi-audio.md). What was missing was a way to *say*
 * which, so the choice was made implicitly by whatever happened to be
 * configured. See `src/lib/syncState.ts`.
 */
export type AudioLocation = "googleDrive" | "server" | "local";

export interface Profile {
  id?: number;
  name: string;
  syncType: SyncType;
  googleDriveFileId?: string | null; // Link to the specific file in user's Drive
  googleDriveFolderId?: string | null; // Link to the per-profile shared folder in Drive
  // Server sync (syncType "server"). Audio still lives in Drive — the server
  // stores only the profile blob, which carries hashes and Drive file IDs.
  serverProfileId?: string | null; // Profile UUID on the ImpAmp server
  serverVersion?: number | null; // Last version we successfully pulled or pushed
  serverShareToken?: string | null; // Link-share token, for profiles opened via a share URL
  // Our access on the server, as the server reported it. Distinguishes an
  // owner from an email-invited editor, which `serverShareToken` cannot:
  // an invited editor has no token. Absent on rows written before this
  // existed — treat that as "unknown", never as "owner".
  serverRole?: "owner" | "editor" | "viewer" | null;
  // The user's intent for this profile's audio. Absent on rows written before
  // this existed; `getSyncState` infers a value for those.
  audioLocation?: AudioLocation | null;
  // What the *remote* allows: reconciled from Drive folder capabilities and
  // from the server's reported access on every sync, so it is a fact about
  // permission rather than a preference.
  readOnly?: boolean; // If true, sync only downloads, never uploads
  // Your own decision to follow this profile rather than contribute to it.
  // Deliberately separate from `readOnly`, which the Drive reconciler
  // overwrites in both directions — a preference stored there is cleared by
  // the next sync of any folder you happen to have write access to.
  followOnly?: boolean;
  activePadBehavior?: ActivePadBehavior;
  /** Loudness normalisation settings. Absent means DEFAULT_NORMALISATION. */
  normalisation?: NormalisationSettings;
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

/**
 * What a trigger does to a pad that already plays.
 *
 * "layer" starts one more overlapping sound, up to `MAX_LAYERS_PER_PAD`. The
 * other three are one-in, one-out and pre-date it.
 *
 * Import this type. It used to be written out again in four places, and
 * another copy is what lets one of them fall behind the others.
 */
export type ActivePadBehavior = "continue" | "stop" | "restart" | "layer";

/**
 * What a trigger must do to this pad, given the profile's default.
 *
 * Every trigger path should ask this rather than reading the pad and the
 * profile itself. It has no caller yet — Task 8 wires it — and note that
 * `TriggerablePad` does not declare the field, so a site that spreads a pad
 * into one drops the override with no compiler error.
 */
export function resolveActivePadBehavior(
  pad: { activePadBehavior?: ActivePadBehavior },
  profileDefault: ActivePadBehavior,
): ActivePadBehavior {
  return pad.activePadBehavior ?? profileDefault;
}

export type PlaybackType = "sequential" | "random" | "round-robin";

/**
 * What a pad plays with when nothing says otherwise.
 *
 * Anywhere a pad can arrive without a playbackType — a drop, a paste, an
 * import of a file that predates the field — must use this. The import paths
 * used to default to "sequential" instead, so importing a profile quietly
 * changed how those pads played.
 */
export const DEFAULT_PLAYBACK_TYPE: PlaybackType = "round-robin";

/** The hard cap on banks per profile. Position 0-19 maps to bank 1-20. */
export const MAX_BANKS = 20;
/** The banks every profile starts with, so every tab has an identity. */
export const DEFAULT_BANK_COUNT = 10;

// Define the structure of pad configuration data
export interface PadConfiguration {
  id?: number;
  profileId: number;
  /**
   * The bank this pad belongs to. Replaces `pageIndex`, which was both the
   * bank's identity and its position; a reorder has to change one without
   * the other. A pad's position is its bank's position, so a second copy
   * here would be a duplicated rule that drifts.
   */
  bankId: string;
  padIndex: number;
  keyBinding?: string;
  name?: string;
  audioFileIds: number[];
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  /**
   * Per-sound manual gain in dB, keyed by audio file ID. Absent or 0 means
   * unity. Applied on top of automatic normalisation, so re-normalising never
   * discards a manual adjustment.
   */
  audioGainSettings?: Record<number, number>;
  /** Whole-pad manual gain in dB, applied on top of per-sound gain. */
  padGainDb?: number;
  playbackType: PlaybackType;
  /**
   * When true the pad keeps its sounds but refuses to play from any trigger
   * (click, key, armed cue, emergency round-robin, search). Undefined means
   * enabled, so records written before this field existed need no migration.
   */
  isDisabled?: boolean;
  /**
   * Overrides the profile's `activePadBehavior` for this pad alone. Undefined
   * means follow the profile, so records written before this field existed need
   * no migration.
   */
  activePadBehavior?: ActivePadBehavior;
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
  /** Immutable identity. Every key that names this bank uses it. */
  bankId: string;
  /** Position only: the tab order and the keyboard shortcut. */
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
  audioFiles: {
    key: number;
    value: AudioFile;
    indexes: { name: string; hash: string };
  };
  profiles: { key: number; value: Profile; indexes: { name: string } };
  padConfigurations: {
    key: number;
    value: PadConfiguration;
    indexes: {
      profileId: number;
      profileBankPad: [number, string, number];
    };
  };
  pageMetadata: {
    key: number;
    value: PageMetadata;
    // No index on [profileId, pageIndex]: two banks may share a position for
    // a moment during a merge, and a unique index would refuse the write.
    indexes: {
      profileId: number;
      profileBank: [number, string];
    };
  };
}

const isClient =
  typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
export const DEFAULT_BACKUP_REMINDER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
let dbPromise: Promise<IDBPDatabase<ImpAmpDBSchema>> | null = null;
// Set inside `upgrade` when a V7 migration runs. Lets `getDb` detect a
// failure that arrives after the versionchange transaction has already
// committed — the one case `transaction.abort()` can't roll back, so
// `openDB()`'s own promise resolves successfully despite it.
let v7MigrationOutcome: Promise<void> | null = null;

// Helper function to iterate and update records within an upgrade transaction
// We need to use a generic transaction type to handle the versionchange transaction
// `migrateV3Shape` folds the V3 reshape (single audioFileId -> audioFileIds +
// playbackType) into this same cursor pass, so a store is never walked by two
// concurrent cursors within the upgrade transaction.
const migrateStoreV4 = (
  transaction: IDBPTransaction<
    ImpAmpDBSchema,
    Array<"profiles" | "audioFiles" | "padConfigurations" | "pageMetadata">,
    "versionchange"
  >,
  storeName: "profiles" | "padConfigurations" | "pageMetadata",
  migrateV3Shape = false,
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

    // Handle the V3 pad shape if this upgrade also crosses version 3
    if (migrateV3Shape && storeName === "padConfigurations") {
      const padUpdateData = updateData as unknown as Record<string, unknown>;
      const legacyAudioFileId = padUpdateData.audioFileId;
      padUpdateData.audioFileIds =
        legacyAudioFileId !== undefined && legacyAudioFileId !== null
          ? [legacyAudioFileId as number]
          : ((padUpdateData.audioFileIds as number[] | undefined) ?? []);
      padUpdateData.playbackType =
        (padUpdateData.playbackType as PlaybackType | undefined) ??
        DEFAULT_PLAYBACK_TYPE;
      if ("audioFileId" in padUpdateData) {
        delete padUpdateData.audioFileId;
      }
    }

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
    v7MigrationOutcome = null;
    dbPromise = openDB<ImpAmpDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, newVersion, transaction) {
        // Removed unused event
        console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);

        // Attached once, unconditionally, so an abort always has a handler.
        // This used to live only inside the `oldVersion < 4` block below, so
        // a transaction abort triggered by a *later* stage — the V7
        // migration's failure path further down is the case that matters —
        // left `transaction.done` rejecting with nobody listening whenever
        // oldVersion was already >= 4 (V4's block, and this catch with it,
        // never ran). `db.v7FailureSurfacing.test.ts` reproduces exactly
        // that gap: forcing a V7 failure on a v6 database (oldVersion = 6)
        // used to report an "Unhandled Rejection" for this same
        // AbortError even after `v7MigrationOutcome` itself got its own
        // catch. `getDb()`'s rejection still carries the real failure either
        // way — this only stops a second, redundant rejection from going
        // unhandled.
        transaction.done.catch((err) => {
          console.error("Transaction failed during upgrade:", err);
        });

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
              "profileBankPad",
              ["profileId", "bankId", "padIndex"],
              {
                unique: true,
              },
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
            store.createIndex("profileBank", ["profileId", "bankId"], {
              unique: true,
            });
          }
        }
        // V3 + V4 Migration. Any upgrade crossing version 3 also crosses version 4,
        // so the V3 pad reshape is applied inside the V4 pass over padConfigurations
        // rather than by a second, concurrent cursor over the same store.
        //
        // `v4Complete` resolves once all three V4 cursor passes have finished.
        // The V7 block below is chained after it deliberately: V7 also reads
        // and rewrites padConfigurations and pageMetadata, and IndexedDB
        // processes requests within a transaction in placement order. Firing
        // both in the same synchronous tick — as this used to — means V7's
        // `getAll()` is placed right behind V4's `openCursor()` and executes
        // before V4's cursor has updated more than (at most) its first row,
        // so V7 snapshots pre-V4 data and then the two passes interleave
        // writes to the same rows with no defined winner: a pad can keep its
        // legacy `audioFileId` and never gain `audioFileIds`, or lose the
        // `bankId` V7 just stamped on it. This is the same "two concurrent
        // cursors over one store" hazard the comment above already fixed
        // once for V3-inside-V4; crossing two *migrations* over the same
        // store is that bug in a different shape. Covered by
        // `db.v7Sequencing.test.ts`, which reproduces the loss with a
        // v3 -> v7 upgrade.
        let v4Complete: Promise<void> = Promise.resolve();
        if (oldVersion < 4) {
          console.log("Applying V4 migration...");
          if (!transaction) {
            throw new Error("V4 Migration: No transaction");
          }
          // transaction.done already has a handler attached unconditionally
          // at the top of `upgrade`, above — no need for a second one here.
          // Queue migrations (don't await directly in upgrade)
          const profilesDone = migrateStoreV4(transaction, "profiles").catch(
            console.error,
          );
          const padsDone = migrateStoreV4(
            transaction,
            "padConfigurations",
            oldVersion < 3,
          ).catch((err) => {
            console.error("V3/V4 Migration Error (padConfigurations):", err);
            try {
              transaction.abort();
            } catch (abortError) {
              console.error("Error aborting transaction:", abortError);
            }
          });
          const pagesDone = migrateStoreV4(transaction, "pageMetadata").catch(
            console.error,
          );
          v4Complete = Promise.all([profilesDone, padsDone, pagesDone]).then(
            () => {},
          );
          console.log("V4 Migration queued.");
        }
        // V5 Migration: add hash index on audioFiles
        if (oldVersion < 5) {
          console.log(
            "Applying V5 migration: adding hash index to audioFiles...",
          );
          const audioStore = transaction.objectStore("audioFiles");
          if (!audioStore.indexNames.contains("hash")) {
            audioStore.createIndex("hash", "hash");
          }
          console.log("V5 Migration complete.");
        }
        // V6 Migration: drop single driveFileId — replaced by per-profile driveFileIds map.
        // Files will be re-uploaded to the correct per-profile folder on next sync.
        if (oldVersion < 6) {
          console.log(
            "Applying V6 migration: removing driveFileId from audioFiles...",
          );
          const audioStore = transaction.objectStore("audioFiles");
          audioStore
            .openCursor()
            .then(function iterate(cursor): Promise<void> {
              if (!cursor) {
                console.log("V6 Migration complete.");
                return Promise.resolve();
              }
              const record = cursor.value as unknown as Record<string, unknown>;
              if ("driveFileId" in record) {
                delete record.driveFileId;
                cursor.update(record as unknown as AudioFile);
              }
              return cursor.continue().then(iterate);
            })
            .catch((err) => console.error("V6 Migration error:", err));
        }

        // V7 Migration: bank identity. The cast is the one place the two
        // schema shapes meet; the migration module owns the pre-v7 shape.
        // Sequenced after `v4Complete` — see the comment on the V4 block
        // above for why racing the two over padConfigurations/pageMetadata
        // loses data.
        if (oldVersion < 7) {
          console.log("Applying V7 migration: bank identity (bankId)...");
          v7MigrationOutcome = v4Complete
            .then(() => migrateToV7(transaction as unknown as V7Transaction))
            .catch((err) => {
              console.error("V7 Migration error:", err);
              try {
                transaction.abort();
              } catch (abortError) {
                // abort() throws when the versionchange transaction has
                // already committed — there is nothing left to roll back.
                // The database is now at version 7 with a partially-applied
                // migration (some rows stamped with bankId, some not), and
                // the next getDb() call would otherwise see oldVersion 7 and
                // never retry. There's no automatic recovery here — that
                // spans the app shell — so this only detects and reports;
                // rethrowing below is what lets `getDb()` surface the
                // failure to its caller instead of only logging it.
                console.error(
                  "V7 Migration: transaction already committed; the database is now at version 7 with a partially-applied migration.",
                  abortError,
                );
              }
              throw err;
            });
          // A silent handler attached alongside the assignment, not instead
          // of the real one below. Promises broadcast to every handler
          // attached to them, so this doesn't consume the rejection — it
          // only stops it from being *unhandled*. That distinction matters
          // on the abort-succeeds path: `openDB()` itself rejects there, so
          // the `.then(async (db) => ...)` callback after `openDB(...)`
          // below — the only other place `v7MigrationOutcome` is awaited —
          // never runs, and without this catch Node reports "Uncaught (in
          // promise)" for an error that already surfaced correctly through
          // the rejected `getDb()` call.
          v7MigrationOutcome.catch(() => {});
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
      blocked(currentVersion, blockedVersion) {
        // This side wanted to upgrade and something else is holding the old
        // version open. Nothing here can close that connection, so say which
        // versions are involved — the fix is to close the other tab.
        console.error(
          `IndexedDB upgrade from ${currentVersion} to ${blockedVersion} is blocked. ` +
            "ImpAmp is open in another tab or window; close it to finish updating.",
        );
      },
      blocking(currentVersion, blockedVersion, event) {
        // *This* connection is the one in the way: another tab is trying to
        // upgrade and cannot while we hold the old version open. Closing is
        // the documented response, and it used to only log — so the other
        // tab's `openDB` never settled, `getDb()` there stayed pending
        // forever, and everything awaiting it (the profile store's load,
        // usePadConfigurations, ensureDefaultProfile) hung with no error and
        // no UI. A blank soundboard that reloading could not fix.
        console.warn(
          `Closing this IndexedDB connection (version ${currentVersion}) so another can upgrade to ${blockedVersion}.`,
        );
        (event.target as IDBDatabase | null)?.close();
        // Drop the memoised connection too, the way `terminated` does: the
        // next getDb() then opens the new schema instead of handing out a
        // closed database.
        dbPromise = null;
      },
      terminated() {
        console.error("IndexedDB terminated.");
        dbPromise = null;
      },
    }).then(async (db) => {
      // Normally already settled by the time the versionchange transaction
      // completes — its requests are what keep the transaction alive. This
      // only has to wait when a V7 migration failure arrived after the
      // transaction had already committed; see the V7 block's comment
      // above. Awaiting it here is what turns that failure into a rejected
      // `getDb()` promise instead of a `console.error` nobody sees.
      if (v7MigrationOutcome) {
        await v7MigrationOutcome;
      }
      return db;
    });
  }
  return dbPromise;
}

// --- Basic CRUD Operations (Updated for Sync Fields) ---

// Compute SHA-256 hash of a Blob, returned as a lowercase hex string
export async function computeBlobHash(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Helper to generate sync fields for new/updated records
const generateSyncFields = (existingRecord?: {
  _created?: number;
}): { _created: number; _modified: number } => {
  const now = Date.now();
  return { _created: existingRecord?._created ?? now, _modified: now };
};

/**
 * The sync bookkeeping a brand-new record needs.
 *
 * Every field counts as modified now, because from this device's point of view
 * it was: the record did not exist a moment ago. Records written without this
 * carry no `_modified` and no `_fieldsModified` at all, which is the entire
 * basis `compareSyncableItems` decides a merge on — an imported profile's pads
 * looked to the merge like they had never been touched, so the first sync
 * could quietly prefer a remote copy over sounds the user had just imported.
 *
 * @param data - The record about to be written
 * @param atMs - The timestamp to stamp, so a batch can share one
 * @returns `_created`, `_modified` and a fully-populated `_fieldsModified`
 */
export function initialSyncFields<T extends object>(
  data: T,
  atMs: number = Date.now(),
): {
  _created: number;
  _modified: number;
  _fieldsModified: Record<string, number>;
} {
  const fieldsModified: Record<string, number> = {};
  for (const key of Object.keys(data)) {
    if (
      !key.startsWith("_") &&
      key !== "id" &&
      key !== "createdAt" &&
      key !== "updatedAt"
    ) {
      fieldsModified[key] = atMs;
    }
  }
  return { _created: atMs, _modified: atMs, _fieldsModified: fieldsModified };
}

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

/**
 * Starts the loudness analysis for one newly written audio file.
 *
 * Analyse in the background. A file being imported is already being decoded,
 * so this is nearly free — but it must never block the import, so it is fired
 * without awaiting. The file plays at 0 dB normalisation until this lands,
 * which is exactly how it behaved before this feature existed.
 *
 * Shared by `addAudioFile` and `addOrReuseAudioFile` so that a row gets its
 * analysis from either writer, and only ever once. A row that
 * `addOrReuseAudioFile` reused keeps the analysis it already has, which is the
 * whole saving: each set of bytes is analysed once, no matter how many pads
 * across how many profiles come to name it.
 */
function startBackgroundAnalysis(id: number): void {
  if (typeof window === "undefined") return;
  void loadLoudnessPipeline()
    .then(({ analyseAndStore }) => analyseAndStore(id))
    .catch((error) => {
      // analyseAndStore already contains its own errors; this only guards
      // the dynamic import itself (e.g. a chunk-load failure). Either way,
      // analysis failing must never surface as an unhandled rejection —
      // the whole design is that an unanalysed file just plays at 0 dB.
      console.warn(
        `[Loudness] Background analysis failed for audio file ${id}:`,
        error,
      );
    });
}

// Add an audio file
export async function addAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<number> {
  const db = await getDb();
  const hash = audioFile.hash ?? (await computeBlobHash(audioFile.blob));
  const tx = db.transaction("audioFiles", "readwrite");
  const id = await tx.store.add({ ...audioFile, hash, createdAt: new Date() });
  await tx.done;
  console.log(`Added audio file with id: ${id}`);

  startBackgroundAnalysis(id);

  return id;
}

// Get an audio file by ID
export async function getAudioFile(id: number): Promise<AudioFile | undefined> {
  const db = await getDb();
  return db.get("audioFiles", id);
}

/**
 * Whole audio rows, bytes included, for the given ids in one transaction.
 *
 * The blob-carrying sibling of `getAudioFileMetadata`, for the callers that
 * genuinely need the bytes — the archive writers. The alternative is
 * `for (const id of ids) await getAudioFile(id)`, and since `getAudioFile` is
 * a bare `db.get`, that is one transaction per sound: a full board of 400 is
 * 400 of them before the ZIP is started, multiplied again by the number of
 * profiles in a multi-profile export.
 *
 * Every `get` is issued before the first `await`, which is what keeps them
 * inside one transaction — IndexedDB commits as soon as the event loop turns
 * with no request outstanding, so awaiting them one at a time would silently
 * give the per-row behaviour back under a batched-looking API.
 *
 * A cursor would be the other shape, and is the wrong one here: it walks rows
 * the caller did not ask for, and `cursor.value` on this store materialises an
 * audio Blob per step. `getAudioFileMetadata` can afford that because it never
 * touches `.blob`; a reader that wants the bytes cannot.
 *
 * @param audioFileIds - Which rows to read; order is not preserved
 * @returns A map from audio file id to its row, omitting ids not found
 */
export async function getAudioFilesByIds(
  audioFileIds: Iterable<number>,
): Promise<Map<number, AudioFile>> {
  const wanted = [...new Set(audioFileIds)];
  const found = new Map<number, AudioFile>();
  if (wanted.length === 0) return found;

  const db = await getDb();
  const store = db.transaction("audioFiles", "readonly").store;
  const rows = await Promise.all(wanted.map((id) => store.get(id)));

  wanted.forEach((id, i) => {
    const row = rows[i];
    if (row) found.set(id, row);
  });
  return found;
}

/** Stores a loudness analysis against an audio file. */
export async function updateAudioFileLoudness(
  id: number,
  loudness: LoudnessAnalysis,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const existing = await tx.store.get(id);
  if (existing) {
    await tx.store.put({ ...existing, loudness });
  }
  await tx.done;
}

/**
 * Lists audio file IDs that need analysis.
 *
 * Iterates with a cursor and reads only the two fields it needs — pulling
 * whole records here would materialise every audio blob at once, since each
 * audioFiles record carries a Blob. `cursor.value.blob` is never read or
 * retained.
 */
export async function findUnanalysedAudioFileIds(
  currentAlgoVersion: number,
): Promise<number[]> {
  const db = await getDb();
  const ids: number[] = [];
  let cursor = await db.transaction("audioFiles").store.openCursor();

  while (cursor) {
    const loudness = cursor.value.loudness;
    if (!loudness || loudness.algoVersion !== currentAlgoVersion) {
      if (cursor.value.id !== undefined) ids.push(cursor.value.id);
    }
    cursor = await cursor.continue();
  }

  return ids;
}

/** An audio file's metadata, without the bytes. */
export interface AudioFileMetadata {
  id: number;
  name: string;
  type: string;
  hash?: string;
  serverHosted?: boolean;
  driveFileIds?: Record<number, string>;
  loudness?: AudioFile["loudness"];
}

/**
 * Metadata for the given audio files, read in one cursor pass.
 *
 * The alternative — and what half a dozen call sites were doing — is
 * `for (const id of ids) await getAudioFile(id)`, which reads the *whole*
 * record each time, Blob included, just to look at a string. On a 960-sound
 * board that is 960 sequential round trips, each materialising an audio file
 * in memory, to answer a question about names and hashes. Some of those sites
 * ran twice per sync, and sync runs on load, every 15 minutes, on reconnect,
 * on every SSE event and 10 seconds after every edit.
 *
 * `cursor.value.blob` is never read or retained, so the bytes stay on disk.
 *
 * @param audioFileIds - Which files to describe; order is not preserved
 * @returns A map from audio file id to its metadata, omitting ids not found
 */
export async function getAudioFileMetadata(
  audioFileIds: Iterable<number>,
): Promise<Map<number, AudioFileMetadata>> {
  const wanted = new Set(audioFileIds);
  const found = new Map<number, AudioFileMetadata>();
  if (wanted.size === 0) return found;

  const db = await getDb();
  let cursor = await db.transaction("audioFiles").store.openCursor();

  while (cursor) {
    const record = cursor.value;
    if (record.id !== undefined && wanted.has(record.id)) {
      found.set(record.id, {
        id: record.id,
        name: record.name,
        type: record.type,
        hash: record.hash,
        serverHosted: record.serverHosted,
        driveFileIds: record.driveFileIds,
        loudness: record.loudness,
      });
      // Stop as soon as everything asked for has been seen.
      if (found.size === wanted.size) break;
    }
    cursor = await cursor.continue();
  }

  return found;
}

/**
 * Clears the stored loudness analysis for exactly the given audio files.
 *
 * Scoped deliberately: audio files are shared between profiles, so a
 * caller must pass the specific IDs it means to re-analyse (typically from
 * `getAudioFileIdsForProfile`) rather than every audio file in the store —
 * otherwise this would discard another profile's measurements too.
 */
export async function clearAudioFileLoudness(
  audioFileIds: Iterable<number>,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  for (const id of audioFileIds) {
    const existing = await tx.store.get(id);
    if (existing?.loudness) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { loudness, ...rest } = existing;
      await tx.store.put(rest);
    }
  }
  await tx.done;
}

// Delete an audio file by ID
export async function deleteAudioFile(id: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  await tx.store.delete(id);
  await tx.done;
  console.log(`Deleted audio file with id: ${id}`);
}

/**
 * The one answer to "does a row already hold these bytes?".
 *
 * Takes the index rather than the hash alone, so a caller that is already
 * inside a transaction can ask without opening a second one — which is what
 * keeps the decision and the write atomic in `addOrReuseAudioFile` and in
 * `importAudioSources`. Two copies of this rule would drift.
 *
 * The empty check is load-bearing, not defensive noise. `index.getAll(key)`
 * with no key is IndexedDB for "every row", so an absent hash — and an archive
 * manifest or a sync blob is unvalidated JSON, whatever the type here says —
 * would be answered with whichever row the store returned first. That is two
 * unrelated sounds merged into one, which no later pass can undo. A missing
 * hash must mean "no match", never "any match".
 */
export async function findAudioFileIdByHashIn(
  hashIndex: { getAll(key: string): Promise<AudioFile[]> },
  hash: string,
): Promise<number | undefined> {
  if (!hash) return undefined;
  const matches = await hashIndex.getAll(hash);
  return matches.find((file) => file.id !== undefined)?.id;
}

/**
 * Adds an audio file, or returns the id of the row that already holds these
 * bytes.
 *
 * Deliberately separate from `addAudioFile`. Callers use the return value to
 * decide what to clean up: `importProfileCore` hands its created ids to
 * `deleteUnreferencedAudioFiles` when an import fails, and a rollback must
 * never delete a row that another profile depends on. `reused` is what lets
 * the caller tell the two apart.
 *
 * Identity is the SHA-256 of the bytes and nothing else, so the same sound
 * under two names collapses to one row. Name and type therefore belong to
 * whichever caller wrote the row first, and a reused row is returned exactly
 * as it was found — including any loudness analysis it already carries.
 *
 * A hash the caller supplies is trusted rather than checked, because that is
 * what lets a shared sound be reused before its bytes are read at all. Equal
 * hashes mean one row: a caller that lies, or a SHA-256 collision, silently
 * drops the second blob. Neither is defended against here.
 *
 * The hash is computed before the transaction opens. `crypto.subtle` is not
 * an IndexedDB request, so an await on it inside a transaction closes it.
 *
 * Audio rows are global rather than per-profile, so reuse crosses profiles:
 * a sound already in the library is reused whichever profile put it there.
 * That is the point, and it is what makes `deleteUnreferencedAudioFiles`'
 * cross-profile correctness load-bearing.
 */
export async function addOrReuseAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<{ id: number; reused: boolean }> {
  // `||` rather than `??`: an empty string is a missing hash, not a key to
  // store rows under. See `findAudioFileIdByHashIn`.
  const hash = audioFile.hash || (await computeBlobHash(audioFile.blob));
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const store = tx.objectStore("audioFiles");

  const existingId = await findAudioFileIdByHashIn(store.index("hash"), hash);
  if (existingId !== undefined) {
    await tx.done;
    return { id: existingId, reused: true };
  }

  const id = await store.add({ ...audioFile, hash, createdAt: new Date() });
  await tx.done;
  startBackgroundAnalysis(id);
  return { id, reused: false };
}

/**
 * A lazy index of local audio by content hash, for files that predate hashing.
 *
 * A factory rather than a module-level cache, deliberately. Each sync pass
 * wants the index built at most once, and wants it built from what the
 * database holds *now* — a cache living longer than the pass would miss every
 * file added since, and silently re-download audio the device already has.
 *
 * Lazy for the same reason it is expensive: building it reads and SHA-256s
 * every audio blob in the library, one at a time so the whole library never
 * sits in memory at once. Most syncs never need it, because the refs carry
 * their hashes; it is only reached when one does not.
 *
 * This existed as two hand-written copies, in the Drive downloader and the
 * hosted-audio downloader, differing only in a temporary variable — which is
 * why the duplication gate never saw them.
 *
 * @returns A getter that builds the index on first call and reuses it after
 */
export function createHashlessAudioIndex(): () => Promise<Map<string, number>> {
  let index: Map<string, number> | null = null;

  return async () => {
    if (index) return index;
    const built = new Map<string, number>();
    const db = await getDb();
    for (const localId of await db.getAllKeys("audioFiles")) {
      const computed = await ensureAudioFileHash(localId);
      if (computed) built.set(computed, localId);
    }
    index = built;
    return index;
  };
}

// Get the hash for an audio file, computing and saving it if not yet stored
export async function ensureAudioFileHash(id: number): Promise<string | null> {
  const db = await getDb();
  const existing = await db.get("audioFiles", id);
  if (!existing) return null;
  if (existing.hash) return existing.hash;

  const hash = await computeBlobHash(existing.blob);
  const tx = db.transaction("audioFiles", "readwrite");
  const record = await tx.store.get(id);
  if (record) {
    await tx.store.put({ ...record, hash });
  }
  await tx.done;
  return hash;
}

/**
 * Record that this deployment's object store holds these files' bytes.
 *
 * Keyed by hash because that is what the hosting side deals in, and because a
 * hash identifies the bytes rather than any one profile's reference to them.
 */
export async function markAudioFilesHosted(hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const index = tx.store.index("hash");
  for (const hash of hashes) {
    for (const file of await index.getAll(hash)) {
      if (file.serverHosted) continue;
      await tx.store.put({ ...file, serverHosted: true });
    }
  }
  await tx.done;
}

// Update the Drive file ID for a specific profile on an audio file record
export async function updateAudioFileDriveId(
  id: number,
  driveFileId: string | null,
  profileId: number,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  const existing = await tx.store.get(id);
  if (existing) {
    const currentMap = existing.driveFileIds ?? {};
    if (driveFileId === null) {
      const newMap = { ...currentMap };
      delete newMap[profileId];
      await tx.store.put({
        ...existing,
        driveFileIds: Object.keys(newMap).length > 0 ? newMap : undefined,
      });
    } else {
      await tx.store.put({
        ...existing,
        driveFileIds: { ...currentMap, [profileId]: driveFileId },
      });
    }
  }
  await tx.done;
}

export async function clearAudioFileDriveIds(profileId: number): Promise<void> {
  const audioFileIds = await getAudioFileIdsForProfile(profileId);
  const db = await getDb();
  const tx = db.transaction("audioFiles", "readwrite");
  for (const id of audioFileIds) {
    const file = await tx.store.get(id);
    if (file?.driveFileIds?.[profileId]) {
      const newMap = { ...file.driveFileIds };
      delete newMap[profileId];
      await tx.store.put({
        ...file,
        driveFileIds: Object.keys(newMap).length > 0 ? newMap : undefined,
      });
    }
  }
  await tx.done;
}

/**
 * The unique audio file ids some pad in this set still names.
 *
 * The single answer to "what counts as referenced", because the alternative
 * has already gone wrong: `deleteProfile` used to compute this itself and knew
 * about the pre-V3 singular `audioFileId` while this did not, so a pad left on
 * the old shape was "referenced" to the delete and "orphaned" to the clean-up
 * button — which then deleted a sound that pad was still using. Such pads
 * should not exist, but `migrateStoreV4` catches a per-record update error and
 * continues, so a record whose rewrite failed keeps the old shape forever.
 */
export function collectReferencedAudioFileIds(
  padConfigurations: (Pick<PadConfiguration, "audioFileIds"> & {
    audioFileId?: number;
  })[],
): Set<number> {
  const audioFileIds = new Set<number>();
  padConfigurations.forEach((pad) => {
    if (pad.audioFileIds && pad.audioFileIds.length > 0) {
      pad.audioFileIds.forEach((id) => audioFileIds.add(id));
    }
    if (typeof pad.audioFileId === "number") {
      audioFileIds.add(pad.audioFileId);
    }
  });
  return audioFileIds;
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

  const audioFileIds = collectReferencedAudioFileIds(padConfigs);

  console.log(
    `Found ${audioFileIds.size} unique audio file IDs for profile ${profileId}`,
  );
  return audioFileIds;
}

// Find orphaned audio files that are not referenced by any pad configuration
/**
 * Splits audio file ids into those some pad still names and those none does.
 *
 * Shared by the read-only scan and the delete, so the two cannot disagree
 * about what "orphaned" means.
 */
function separateOrphans(
  allAudioKeys: IDBValidKey[],
  allPadConfigs: PadConfiguration[],
): { orphanedIds: Set<number>; referencedIds: Set<number> } {
  const referencedIds = collectReferencedAudioFileIds(allPadConfigs);
  const orphanedIds = new Set<number>();

  for (const audioId of allAudioKeys) {
    if (typeof audioId === "number" && !referencedIds.has(audioId)) {
      orphanedIds.add(audioId);
    }
  }

  return { orphanedIds, referencedIds };
}

/**
 * Drops decoded-buffer cache entries for audio whose records have gone.
 *
 * Exported because the duplicate collapse deletes rows too, and a decoded
 * buffer still cached under a deleted id is a sound that can play after its
 * row is gone.
 *
 * Dynamic import for the same reason the other callers use one: `audio/cache`
 * reaches Web Audio, and `db.ts` is imported by code that runs on the server.
 */
export async function clearAudioCacheEntries(
  ids: Iterable<number>,
): Promise<number> {
  if (typeof window === "undefined") return 0;
  try {
    const { clearCachedAudioBuffer } = await import("./audio/cache");
    let cleared = 0;
    for (const id of ids) {
      if (clearCachedAudioBuffer(id)) cleared++;
    }
    return cleared;
  } catch (error) {
    console.warn("Failed to clear audio cache entries:", error);
    return 0;
  }
}

/**
 * Deletes specific audio files, keeping any a pad still names.
 *
 * For cleaning up after a write that got halfway: an import creates its audio
 * records before the pads that reference them, so a failure in between leaves
 * files no pad has ever named. `deleteProfile` cannot reach those — it derives
 * what to delete from the profile's pad configurations, and in that window
 * there are none — and nothing else sweeps them without the user pressing the
 * orphan-cleanup button. A 2 GB restore that failed at the last step used to
 * leave 2 GB behind, and each retry left another copy.
 *
 * Deciding and deleting share one transaction, so nothing can start
 * referencing a file between the two.
 *
 * @param candidateIds The ids this operation created
 * @returns How many were actually deleted
 */
export async function deleteUnreferencedAudioFiles(
  candidateIds: Iterable<number>,
): Promise<number> {
  const candidates = new Set(candidateIds);
  if (candidates.size === 0) return 0;

  const db = await getDb();
  const tx = db.transaction(["audioFiles", "padConfigurations"], "readwrite");
  const allPadConfigs = await tx.objectStore("padConfigurations").getAll();
  const referencedIds = collectReferencedAudioFileIds(allPadConfigs);
  const audioStore = tx.objectStore("audioFiles");

  const deletedIds: number[] = [];
  for (const audioFileId of candidates) {
    if (referencedIds.has(audioFileId)) continue;
    await audioStore.delete(audioFileId);
    deletedIds.push(audioFileId);
  }
  await tx.done;

  await clearAudioCacheEntries(deletedIds);
  return deletedIds.length;
}

/**
 * Imports that are partway through attaching audio to pads.
 *
 * An import writes its audio records first and the pads that name them
 * several steps later, and it cannot do otherwise: a pad names its sounds by
 * the ids the audio store assigns on write, so those ids do not exist until
 * the audio does. Between the two moments the audio is real and nothing
 * references it — which is precisely what `cleanupOrphanedAudioFiles` exists
 * to delete. A cleanup landing in that window took sounds out from under an
 * import that then wrote pads naming files that were already gone.
 *
 * So an import declares itself here (`withAudioImportInProgress`) and every
 * deleter waits for it to finish before it looks. That is a guarantee
 * rather than a guess: no timer, nothing to tune, and no dependence on how
 * long the import takes. The alternatives do not survive contact with the
 * code. A grace period on recently-created audio cannot work at all —
 * `importAudioSources` stamps every record with the one `now` taken when the
 * import began, so after ten minutes of downloads its files are ten minutes
 * old at the moment its pads are written, and any grace period short enough
 * to still clean up is already too short. One transaction spanning the whole
 * import is not merely slow but impossible: an IndexedDB transaction commits
 * as soon as the event loop turns with no request outstanding, and an import
 * awaits a network download between files.
 *
 * The register is in memory, so it is exactly as wide as one tab: a second
 * tab importing while this one sweeps is still unprotected. That is the
 * honest limit of this fix — the register would have to move into the
 * database, or onto the Web Locks API, to cover it — and it is a far smaller
 * hole than the one it replaces, since both operations are ordinary
 * foreground work in the tab the user is looking at.
 */
const audioImportsInFlight = new Set<Promise<void>>();

/**
 * Runs an import that writes audio, holding off the orphan sweeps until it
 * has finished writing the pads that name it.
 *
 * The import's own outcome is passed straight back to the caller; the copy
 * kept here absorbs the rejection so that a failed import releases the sweeps
 * instead of wedging them behind an unhandled promise.
 */
export function withAudioImportInProgress<T>(
  run: () => Promise<T>,
): Promise<T> {
  const running = run();
  const tracked = running.then(
    () => {},
    () => {},
  );
  audioImportsInFlight.add(tracked);
  void tracked.then(() => audioImportsInFlight.delete(tracked));
  return running;
}

/**
 * Waits until no import is midway through attaching audio.
 *
 * Loops rather than awaiting one snapshot, because an import can start while
 * we are waiting for another. Callers must open their transaction in the same
 * turn this returns in: an import that registers *after* that transaction
 * exists is harmless — IndexedDB serialises its audio write behind the
 * sweep's overlapping readwrite scope, so the sweep never sees the new
 * records at all — but one that registers in a turn between the two would be
 * missed.
 *
 * **Exported because the rule is repo-wide, not db.ts-wide.** Anything that
 * deletes audio rows it did not itself create has to call this immediately
 * before opening its transaction. It was private, and the one such deleter
 * written outside this file — `collapseDuplicateAudioGroups` — shipped
 * without the guard because there was no way to reach it. Being unreachable
 * is not the same as being unnecessary.
 *
 * `deleteUnreferencedAudioFiles` is the deliberate exception: it only ever
 * considers ids its own caller just created, so an unrelated import's rows
 * are not in range and waiting for one would only make a failed import
 * slower to clean up after.
 */
export async function settleAudioImports(): Promise<void> {
  while (audioImportsInFlight.size > 0) {
    await Promise.all([...audioImportsInFlight]);
  }
}

export async function findOrphanedAudioFiles(): Promise<{
  orphanedIds: Set<number>;
  referencedIds: Set<number>;
  totalAudioFiles: number;
}> {
  const db = await getDb();

  // Nothing to report while an import is midway through attaching its audio:
  // its files are unreferenced by construction, and counting them as orphans
  // is what invites the user to press the button that deletes them.
  await settleAudioImports();

  // One transaction over both stores, so the two halves describe the same
  // instant. Read separately, an import that had committed its audio but not
  // yet its pads looked like a pile of unreferenced files.
  const tx = db.transaction(["audioFiles", "padConfigurations"], "readonly");
  const allAudioFiles = await tx.objectStore("audioFiles").getAllKeys();
  const allPadConfigs = await tx.objectStore("padConfigurations").getAll();
  await tx.done;

  const { orphanedIds, referencedIds } = separateOrphans(
    allAudioFiles,
    allPadConfigs,
  );

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

  let orphanedIds = new Set<number>();

  try {
    // Deciding *and* deleting inside one transaction, so nothing can start
    // referencing a file between the two. The scan and the delete used to be
    // three separate transactions, and a pad write landing between them was
    // ignored — the delete acted on a list already out of date.
    //
    // Every await below is an IndexedDB request, which is what keeps the
    // transaction alive; anything else here would let it auto-close.
    //
    // The transaction cannot close the *other* window, the one between an
    // import writing its audio and writing the pads that name it: it opens
    // after that audio is already there and sees exactly what the import left
    // behind, files nothing references yet. Waiting for the import is what
    // closes that one — and it has to be the last thing before the
    // transaction is created, so that no import can register in between (see
    // `settleAudioImports`).
    await settleAudioImports();
    const tx = db.transaction(["audioFiles", "padConfigurations"], "readwrite");
    const audioStore = tx.objectStore("audioFiles");
    const allAudioKeys = await audioStore.getAllKeys();
    const allPadConfigs = await tx.objectStore("padConfigurations").getAll();

    orphanedIds = separateOrphans(allAudioKeys, allPadConfigs).orphanedIds;

    if (orphanedIds.size === 0) {
      await tx.done;
      console.log("[Orphan Cleanup] No orphaned audio files found");
      return { deletedCount: 0, cacheEntriesCleared: 0, errors: [] };
    }

    console.log(
      `[Orphan Cleanup] Starting cleanup of ${orphanedIds.size} orphaned audio files...`,
    );

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
    await tx.done;

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
  const syncFields = initialSyncFields(profileData, nowMs);

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
    _fieldsModified: syncFields._fieldsModified,
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
  let txSettled = false;
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
    txSettled = true;
    console.log(`[DB] Successfully updated profile with id: ${id}`);
  } catch (error) {
    console.error(`[DB] Failed to update profile ${id}:`, error);
    if (!txSettled) {
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
  let txSettled = false;
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

    // Audio files can be shared between profiles (sync deduplicates by hash and
    // by name), so collect everything still referenced by the remaining profiles
    // and keep those files. Through the shared helper, so this cannot drift
    // from what the orphan scan and the clean-up button call referenced — it
    // already had, over the legacy singular `audioFileId`.
    const survivingPads: PadConfiguration[] = [];
    let refCursor = await padStore.openCursor();
    while (refCursor) {
      if (refCursor.value.profileId !== id) {
        survivingPads.push(refCursor.value);
      }
      refCursor = await refCursor.continue();
    }
    const stillReferencedIds = collectReferencedAudioFileIds(survivingPads);

    // Delete the audio files this profile exclusively referenced
    const deletableAudioFileIds = new Set(
      [...audioFileIds].filter((audioId) => !stillReferencedIds.has(audioId)),
    );
    const audioStore = tx.objectStore("audioFiles");
    for (const audioFileId of deletableAudioFileIds) {
      await audioStore.delete(audioFileId);
    }

    await tx.done;
    txSettled = true;

    // Clear audio cache entries for deleted audio files
    // Import dynamically to avoid circular dependency issues
    if (typeof window !== "undefined") {
      try {
        const { clearCachedAudioBuffer } = await import("./audio/cache");
        let clearedCacheCount = 0;
        for (const audioFileId of deletableAudioFileIds) {
          if (clearCachedAudioBuffer(audioFileId)) {
            clearedCacheCount++;
          }
        }
        console.log(
          `Deleted profile with id: ${id} and all associated data including ${deletableAudioFileIds.size} audio files (${clearedCacheCount} cache entries cleared)`,
        );
      } catch (cacheError) {
        console.warn("Failed to clear audio cache entries:", cacheError);
        console.log(
          `Deleted profile with id: ${id} and all associated data including ${deletableAudioFileIds.size} audio files`,
        );
      }
    } else {
      console.log(
        `Deleted profile with id: ${id} and all associated data including ${deletableAudioFileIds.size} audio files`,
      );
    }
  } catch (error) {
    console.error(`Failed to delete profile ${id}:`, error);
    if (!txSettled) {
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

// Fields updated by backup/sync operations that should NOT count as user content changes
const BACKUP_ONLY_FIELDS = new Set([
  "lastBackedUpAt",
  "backupReminderPeriod",
  "syncType",
  "googleDriveFileId",
  "syncPausedUntil",
  // Where the audio lives, and the folder it lives in. Moving sounds between
  // Drive and the server changes nothing about the soundboard itself, so it
  // should not make the app ask for a fresh backup.
  "audioLocation",
  "googleDriveFolderId",
  // Server-sync bookkeeping: where the profile lives, which version we last
  // saw, and what we are allowed to do with it — none of which is user
  // content.
  "serverProfileId",
  "serverVersion",
  "serverShareToken",
  "serverRole",
  "readOnly",
  "followOnly",
]);

/**
 * Whether a bank row is one the app wrote for itself and nobody has touched
 * since — the bank equivalent of `BACKUP_ONLY_FIELDS` above.
 *
 * Banks 1-10 used to be synthesised in the page component, so an unedited
 * profile carried no `pageMetadata` rows at all. Since v7 they are real rows,
 * materialised by `ensureDefaultBanks` and by `migrateToV7`'s pass 1, both
 * stamped with the moment they were written. Those rows still have to *sync* —
 * materialising a bank genuinely is a change to the profile's data, and
 * dropping their `_created`/`_modified` would break the merge — so the
 * housekeeping has to be recognised here, at the one place that asks "did the
 * user change anything worth backing up?", rather than at the write.
 *
 * A row counts as untouched only if it still looks exactly the way those two
 * paths write it: the deterministic migrated id, sitting at the position that
 * id encodes, under that position's default name, not an emergency bank, and
 * with no modification after its creation. Any edit breaks at least one of
 * those — a rename changes `name`, the emergency toggle changes
 * `isEmergency`, a reorder moves the row away from the position its id
 * encodes and bumps `_modified`, and a bank the user added has a random id.
 */
function isUntouchedDefaultBank(bank: PageMetadata): boolean {
  return (
    bank.bankId === migratedBankId(bank.pageIndex) &&
    bank.name === `Bank ${convertIndexToBankNumber(bank.pageIndex)}` &&
    !bank.isEmergency &&
    (bank._modified === undefined || bank._modified === bank._created)
  );
}

// Records restored from sync payloads can carry ISO strings rather than Dates,
// so coerce before comparing. Unusable values are treated as "not changed".
function toTimestamp(value: Date | string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export async function hasProfileChangedSince(
  profileId: number,
  since: number,
): Promise<boolean> {
  const db = await getDb();

  // Check profile _fieldsModified for any content field changed after 'since'.
  // Using _fieldsModified rather than updatedAt because updateProfile() always
  // bumps updatedAt to new Date(), including during export (which would make
  // updatedAt always newer than lastBackedUpAt by a few ms).
  const profile = await db.get("profiles", profileId);
  if (profile?._fieldsModified) {
    const hasProfileContentChange = Object.entries(
      profile._fieldsModified,
    ).some(
      ([key, timestamp]) => !BACKUP_ONLY_FIELDS.has(key) && timestamp > since,
    );
    if (hasProfileContentChange) return true;
  }

  // Check pad configurations
  const padTx = db.transaction("padConfigurations", "readonly");
  const pads = await padTx
    .objectStore("padConfigurations")
    .index("profileId")
    .getAll(profileId);
  await padTx.done;
  if (pads.some((pad) => toTimestamp(pad.updatedAt) > since)) return true;

  // Check page metadata
  const pageTx = db.transaction("pageMetadata", "readonly");
  const pages = await pageTx
    .objectStore("pageMetadata")
    .index("profileId")
    .getAll(profileId);
  await pageTx.done;
  if (
    pages.some(
      (page) =>
        !isUntouchedDefaultBank(page) && toTimestamp(page.updatedAt) > since,
    )
  )
    return true;

  return false;
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
  const index = store.index("profileBankPad");
  const now = new Date();
  const nowMs = now.getTime();
  let txSettled = false;

  try {
    const existing = await index.get([
      padConfig.profileId,
      padConfig.bankId,
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
      const syncFields = initialSyncFields(padConfig, nowMs);
      const addData: Omit<PadConfiguration, "id"> = {
        ...padConfig,
        createdAt: now,
        updatedAt: now,
        _created: syncFields._created,
        _modified: syncFields._modified,
        _fieldsModified: syncFields._fieldsModified,
      };
      id = await store.add(addData);
      console.log(`Added pad configuration with id: ${id}`);
    }
    await tx.done;
    txSettled = true;
    return id;
  } catch (error) {
    console.error("Error in upsertPadConfiguration:", error);
    if (!txSettled) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

/**
 * Everything the playback path needs from a pad.
 *
 * This exists because the trigger arguments used to be hand-copied at roughly
 * ten call sites, and every field on it is optional — so adding a field and
 * missing one site produced no compiler error, just a pad that played at the
 * wrong level when triggered from one particular path. Funnel every site
 * through extractPadPlaybackSettings instead.
 */
export type PadPlaybackSettings = Pick<
  PadConfiguration,
  | "audioFileIds"
  | "audioTrimSettings"
  | "audioGainSettings"
  | "padGainDb"
  | "playbackType"
  | "isDisabled"
  | "activePadBehavior"
  | "name"
>;

export function extractPadPlaybackSettings(
  pad: Partial<PadConfiguration>,
): PadPlaybackSettings {
  return {
    audioFileIds: pad.audioFileIds ?? [],
    audioTrimSettings: pad.audioTrimSettings,
    audioGainSettings: pad.audioGainSettings,
    padGainDb: pad.padGainDb,
    playbackType: pad.playbackType ?? DEFAULT_PLAYBACK_TYPE,
    isDisabled: pad.isDisabled ?? false,
    // Deliberately not defaulted: undefined *is* the value that means "follow
    // the profile", and `resolveActivePadBehavior` is the only place that rule
    // is applied. Defaulting here would freeze the profile's setting at the
    // moment a pad was copied.
    activePadBehavior: pad.activePadBehavior,
    name: pad.name,
  };
}

// The part of a pad configuration that moves with the sound during a swap.
// Key bindings are deliberately excluded: they belong to the pad position.
type PadContent = PadPlaybackSettings;

// Swap the contents of two pads on the same bank in a single transaction, so a
// failure can never leave a sound assigned to neither pad.
export async function swapPadConfigurations(
  profileId: number,
  bankId: string,
  fromPadIndex: number,
  toPadIndex: number,
): Promise<void> {
  if (fromPadIndex === toPadIndex) return;

  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readwrite");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profileBankPad");
  const now = new Date();
  const nowMs = now.getTime();
  let txSettled = false;

  try {
    const fromExisting = await index.get([profileId, bankId, fromPadIndex]);
    const toExisting = await index.get([profileId, bankId, toPadIndex]);

    if (!fromExisting) {
      throw new Error(
        `Pad configuration not found for profile ${profileId}, bank ${bankId}, pad ${fromPadIndex}`,
      );
    }

    const fromContent: PadContent = extractPadPlaybackSettings(fromExisting);
    const toContent: PadContent = extractPadPlaybackSettings(toExisting ?? {});

    const writePad = async (
      padIndex: number,
      existing: PadConfiguration | undefined,
      content: PadContent,
    ) => {
      if (existing) {
        const syncFields = generateSyncFields(existing);
        await store.put({
          ...existing,
          ...content,
          updatedAt: now,
          _modified: syncFields._modified,
          _fieldsModified: updateFieldsModified(
            content,
            existing,
            existing._fieldsModified,
          ),
        });
        return;
      }
      const record = { profileId, bankId, padIndex, ...content };
      const syncFields = initialSyncFields(record, nowMs);
      await store.add({
        ...record,
        createdAt: now,
        updatedAt: now,
        _created: syncFields._created,
        _modified: syncFields._modified,
        _fieldsModified: syncFields._fieldsModified,
      });
    };

    // Existing records are updated in place, so the unique profileBankPad index
    // is never violated and neither pad has to be emptied first.
    await writePad(toPadIndex, toExisting, fromContent);
    await writePad(fromPadIndex, fromExisting, toContent);

    await tx.done;
    txSettled = true;
    console.log(
      `Swapped pads ${fromPadIndex} and ${toPadIndex} on bank ${bankId} for profile ${profileId}`,
    );
  } catch (error) {
    console.error("Error in swapPadConfigurations:", error);
    if (!txSettled) {
      try {
        tx.abort();
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

/**
 * Every pad row of one profile, across all of its banks.
 *
 * The `profileId` index, not a filter over `profileBankPad`: a caller that
 * wants per-bank counts would otherwise have to range the composite index once
 * per bank, and a caller that grouped the whole store by `bankId` would fold
 * another profile's bank of the same id into the answer — two profiles both
 * holding a bank called "0" is the ordinary case, not a corner, because that
 * is the id `ensureDefaultBanks` gives every profile's first bank.
 */
export async function getPadConfigurationsForProfile(
  profileId: number,
): Promise<PadConfiguration[]> {
  const db = await getDb();
  return db.getAllFromIndex("padConfigurations", "profileId", profileId);
}

// Get all pad configurations for a specific profile and bank
export async function getPadConfigurationsForProfileBank(
  profileId: number,
  bankId: string,
): Promise<PadConfiguration[]> {
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readonly");
  const store = tx.objectStore("padConfigurations");
  const index = store.index("profileBankPad");
  const range = IDBKeyRange.bound(
    [profileId, bankId, -Infinity],
    [profileId, bankId, Infinity],
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

// Get one bank of a profile by its identity
export async function getBankById(
  profileId: number,
  bankId: string,
): Promise<PageMetadata | undefined> {
  const db = await getDb();
  return db.getFromIndex("pageMetadata", "profileBank", [profileId, bankId]);
}

// Function to get all page metadata for a specific profile
export async function getAllPageMetadataForProfile(
  profileId: number,
): Promise<PageMetadata[]> {
  const db = await getDb();
  return db.getAllFromIndex("pageMetadata", "profileId", profileId);
}

// Function to add or update page metadata (Updated)
/**
 * Writes bank metadata, touching only the fields it is given.
 *
 * `name` and `isEmergency` are optional so a caller changing one does not have
 * to read and re-send the other. They used to be required, which meant
 * `renameBank` and `setBankEmergencyState` each read the record *outside* this
 * transaction and wrote both fields back — so renaming a bank while toggling
 * its emergency flag reverted whichever landed first. The merge inside the
 * transaction below already does the right thing; the callers just were not
 * allowed to use it.
 */
export async function upsertPageMetadata(pageMetadata: {
  profileId: number;
  bankId: string;
  pageIndex?: number;
  name?: string;
  isEmergency?: boolean;
}): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const index = store.index("profileBank");
  const now = new Date();
  const nowMs = now.getTime();
  let txSettled = false;

  try {
    const existing = await index.get([
      pageMetadata.profileId,
      pageMetadata.bankId,
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
      // Defaults only matter here — an update keeps what is there.
      if (pageMetadata.pageIndex === undefined) {
        throw new Error(
          `Cannot create bank ${pageMetadata.bankId} without a position. Use createBank or ensureDefaultBanks.`,
        );
      }
      const content = {
        ...pageMetadata,
        pageIndex: pageMetadata.pageIndex,
        name:
          pageMetadata.name ??
          `Bank ${convertIndexToBankNumber(pageMetadata.pageIndex)}`,
        isEmergency: pageMetadata.isEmergency ?? false,
      };
      const syncFields = initialSyncFields(content, nowMs);
      const addData: Omit<PageMetadata, "id"> = {
        ...content,
        createdAt: now,
        updatedAt: now,
        _created: syncFields._created,
        _modified: syncFields._modified,
        _fieldsModified: syncFields._fieldsModified,
      };
      id = await store.add(addData);
      console.log(`Added page metadata with id: ${id}`);
    }
    await tx.done;
    txSettled = true;
    return id;
  } catch (error) {
    console.error("Error in upsertPageMetadata:", error);
    if (!txSettled) {
      try {
        tx.abort();
        // The "missing position" guard above throws before any write, so
        // this abort has nothing to roll back — it only exists to settle
        // the transaction. Without the catch here, idb's `tx.done` (created
        // as soon as the transaction is) rejects with an AbortError that
        // nothing observes, and that unhandled rejection fails the run even
        // though every assertion passed.
        tx.done.catch(() => {});
      } catch (e) {
        console.error("Error aborting transaction:", e);
      }
    }
    throw error;
  }
}

// Helper function to rename a bank (Updated)
export async function renameBank(
  profileId: number,
  bankId: string,
  newName: string,
): Promise<void> {
  try {
    // Only the name. Reading `isEmergency` here and writing it back is what
    // let a rename revert a concurrent emergency toggle.
    await upsertPageMetadata({ profileId, bankId, name: newName });
    console.log(`Renamed bank ${bankId} to "${newName}"`);
  } catch (error) {
    console.error(`Error renaming bank ${bankId}:`, error);
    throw error;
  }
}

// Helper function to set emergency state for a bank (Updated)
export async function setBankEmergencyState(
  profileId: number,
  bankId: string,
  isEmergency: boolean,
): Promise<void> {
  try {
    // Only the flag — see renameBank.
    await upsertPageMetadata({ profileId, bankId, isEmergency });
    console.log(`Set emergency state for bank ${bankId} to ${isEmergency}`);
  } catch (error) {
    console.error(`Error setting emergency state for bank ${bankId}:`, error);
    throw error;
  }
}

/**
 * Makes sure a profile has its ten default banks.
 *
 * The ids are deterministic — `String(position)` — for the reason the v7
 * migration gives: two devices can materialise the same default bank on
 * their own, and a random id would give the merge two banks where there is
 * one. No path deletes a bank, so these ten ids are stable forever.
 *
 * @param profileId - The profile to fill
 * @returns Every bank of the profile, in normalised order
 */
export async function ensureDefaultBanks(
  profileId: number,
): Promise<PageMetadata[]> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const existing = await store.index("profileId").getAll(profileId);
  const known = new Set(existing.map((bank) => bank.bankId));
  const now = new Date();
  const nowMs = now.getTime();
  const created: PageMetadata[] = [];

  for (let position = 0; position < DEFAULT_BANK_COUNT; position++) {
    const bankId = String(position);
    if (known.has(bankId)) continue;
    const content = {
      profileId,
      bankId,
      pageIndex: position,
      name: `Bank ${convertIndexToBankNumber(position)}`,
      isEmergency: false,
    };
    const id = await store.add({
      ...content,
      createdAt: now,
      updatedAt: now,
      ...initialSyncFields(content, nowMs),
    });
    created.push({ ...content, id, createdAt: now, updatedAt: now });
  }
  await tx.done;

  return normaliseBankOrder([...existing, ...created]);
}

/**
 * Adds one bank at the first free position.
 *
 * @param profileId - The profile to add to
 * @param name - The bank name
 * @param isEmergency - Whether the bank answers the emergency key
 * @returns The bank that was written
 */
export async function createBank(
  profileId: number,
  name: string,
  isEmergency = false,
): Promise<PageMetadata> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const existing = await store.index("profileId").getAll(profileId);
  if (existing.length >= MAX_BANKS) {
    await tx.done;
    throw new Error(`A profile can hold at most ${MAX_BANKS} banks.`);
  }

  const used = new Set(existing.map((bank) => bank.pageIndex));
  let pageIndex = 0;
  while (used.has(pageIndex)) pageIndex++;

  const now = new Date();
  // A bank created after the migration is safe with a random id: a creation
  // is a synced event, so two devices cannot mint one for the same bank.
  const content = {
    profileId,
    bankId: crypto.randomUUID(),
    pageIndex,
    name,
    isEmergency,
  };
  const id = await store.add({
    ...content,
    createdAt: now,
    updatedAt: now,
    ...initialSyncFields(content, now.getTime()),
  });
  await tx.done;

  return { ...content, id, createdAt: now, updatedAt: now };
}

/**
 * Writes a new bank order.
 *
 * One transaction over `pageMetadata`. Position is an ordinary field, so a
 * reorder moves no pad row and stresses no unique index. Only a bank that
 * really changed position gets a fresh sync stamp, so the merge sees a
 * position change rather than a mass rename.
 *
 * @param profileId - The profile whose banks move
 * @param orderedBankIds - The identities, in the new order. An id the
 *   profile does not hold is ignored. A repeated id is placed at its first
 *   occurrence only; later repeats are ignored. A bank the caller does not
 *   name (including every bank, when this is empty) keeps its relative
 *   order, after the named ones.
 */
export async function reorderBanks(
  profileId: number,
  orderedBankIds: string[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("pageMetadata", "readwrite");
  const store = tx.objectStore("pageMetadata");
  const banks = await store.index("profileId").getAll(profileId);
  const byId = new Map(banks.map((bank) => [bank.bankId, bank]));

  const ordered: PageMetadata[] = [];
  for (const bankId of orderedBankIds) {
    const bank = byId.get(bankId);
    if (!bank) continue;
    byId.delete(bankId);
    ordered.push(bank);
  }
  // Sorted with the shared comparator rather than renumbered, because the
  // loop below decides what to write by the *old* position.
  ordered.push(...[...byId.values()].sort(compareBankOrder));

  const now = new Date();
  const nowMs = now.getTime();
  for (let position = 0; position < ordered.length; position++) {
    const bank = ordered[position];
    if (bank.pageIndex === position) continue;
    await store.put({
      ...bank,
      pageIndex: position,
      updatedAt: now,
      _modified: nowMs,
      _fieldsModified: { ...(bank._fieldsModified ?? {}), pageIndex: nowMs },
    });
  }
  await tx.done;
}

// Find audio file IDs referenced by pads that no longer exist in the audioFiles store
export interface MissingAudioFile {
  profileId: number;
  profileName: string;
  bankId: string;
  bankName: string;
  padIndex: number;
  padName: string;
  missingAudioFileId: number;
}

export async function findMissingAudioFiles(): Promise<MissingAudioFile[]> {
  const db = await getDb();

  // Get all existing audio file IDs
  const audioTx = db.transaction("audioFiles", "readonly");
  const existingIds = new Set<number>(
    (await audioTx.store.getAllKeys()) as number[],
  );
  await audioTx.done;

  // Get all pad configurations
  const padTx = db.transaction("padConfigurations", "readonly");
  const allPads = await padTx.store.getAll();
  await padTx.done;

  // Build profile name map
  const profiles = await getAllProfiles();
  const profileNameMap = new Map<number, string>(
    profiles.map((p) => [p.id!, p.name]),
  );

  // Build bank name map, keyed on profileId+bankId together: bankId alone
  // collides across profiles, because every profile migrated from the
  // pre-bankId schema names its banks "0", "1", "2", ... (Task 2's migration
  // assigns migrated banks the deterministic id String(pageIndex)). Only
  // banks created after that migration get a UUID.
  const allBanks = await db.getAll("pageMetadata");
  const bankNameMap = new Map<string, string>(
    allBanks.map((bank) => [`${bank.profileId}:${bank.bankId}`, bank.name]),
  );

  const results: MissingAudioFile[] = [];
  for (const pad of allPads) {
    if (!pad.audioFileIds) continue;
    for (const audioFileId of pad.audioFileIds) {
      if (!existingIds.has(audioFileId)) {
        results.push({
          profileId: pad.profileId,
          profileName:
            profileNameMap.get(pad.profileId) ?? `Profile ${pad.profileId}`,
          bankId: pad.bankId,
          bankName:
            bankNameMap.get(`${pad.profileId}:${pad.bankId}`) ?? "Bank ?",
          padIndex: pad.padIndex,
          padName: pad.name ?? "",
          missingAudioFileId: audioFileId,
        });
      }
    }
  }

  console.log(
    `[Missing Audio] Found ${results.length} missing audio file references`,
  );
  return results;
}

// Replace a missing audio file reference with a new file
export async function replaceMissingAudioFile(
  profileId: number,
  bankId: string,
  padIndex: number,
  missingAudioFileId: number,
  file: File,
): Promise<void> {
  const blob = file as Blob;
  const hash = await computeBlobHash(blob);

  // Reuse rather than add. A repair means picking the file off disk again,
  // and the bytes are very often already in the library — under another pad,
  // or under this profile's own copy of the same sound. Adding a second row
  // is how a library grows a duplicate of everything a user has re-linked.
  const { id: newId } = await addOrReuseAudioFile({
    name: file.name,
    type: file.type,
    blob,
    hash,
  });

  // Update the pad configuration to swap the missing ID for the new one
  const db = await getDb();
  const tx = db.transaction("padConfigurations", "readwrite");
  const store = tx.objectStore("padConfigurations");
  const existing = await store
    .index("profileBankPad")
    .get([profileId, bankId, padIndex]);

  if (!existing) {
    await tx.done;
    throw new Error(
      `Pad configuration not found for profile ${profileId}, bank ${bankId}, pad ${padIndex}`,
    );
  }

  const updatedIds = existing.audioFileIds.map((id) =>
    id === missingAudioFileId ? newId : id,
  );
  const now = new Date();
  const syncFields = generateSyncFields(existing);
  await store.put({
    ...existing,
    audioFileIds: updatedIds,
    updatedAt: now,
    _modified: syncFields._modified,
    _fieldsModified: {
      ...existing._fieldsModified,
      audioFileIds: now.getTime(),
    },
  });
  await tx.done;

  console.log(
    `[Missing Audio] Replaced missing file ID ${missingAudioFileId} with new file ID ${newId} in pad ${padIndex} on bank ${bankId}`,
  );
}

// Only initialize the database on the client side
if (isClient) {
  getDb().catch(console.error);
}

/**
 * Copy a profile into a fresh local one.
 *
 * The way out for someone looking at a board they cannot change: a viewer of
 * a shared profile could otherwise only look at it, never build on it.
 *
 * Audio is *referenced*, not copied. Pads already point at audio files by id
 * and those files are shared across profiles — that is how the orphan scan
 * counts references — so a copy is instant and costs no storage, where
 * re-importing would re-download every sound.
 *
 * The copy is deliberately local and unlinked: it is yours, and connecting it
 * anywhere is a separate decision.
 */
export async function duplicateProfileLocally(
  sourceProfileId: number,
  name: string,
): Promise<number> {
  const db = await getDb();
  const source = await db.get("profiles", sourceProfileId);
  if (!source) throw new Error(`Profile ${sourceProfileId} not found.`);

  const newProfileId = await addProfile({
    name,
    // Deliberately local: a duplicate is a new thing, and inheriting where the
    // original synced would have two profiles publishing to one destination.
    syncType: "local",
    activePadBehavior: source.activePadBehavior,
    // Settings that change how the copy *sounds* or when it nags. A duplicate
    // that normalises differently from its original is not a duplicate.
    normalisation: source.normalisation,
    backupReminderPeriod: source.backupReminderPeriod,
  });

  // The pads and pages go in one at a time, so a failure part-way — a pad row
  // missing `playbackType`, a quota refusal — would otherwise leave a
  // half-copied profile sitting in the list looking complete. There is no
  // transaction spanning all of it, so undo it by hand instead.
  try {
    // The bank rows go first, so every pad already has a bank to belong to
    // by the time it is written.
    for (const bank of await getAllPageMetadataForProfile(sourceProfileId)) {
      // The copy keeps the source's identities. The two profiles never
      // merge with each other, so a shared id is safe, and it keeps the
      // copy's tab order the same as the original's.
      await upsertPageMetadata({
        profileId: newProfileId,
        bankId: bank.bankId,
        pageIndex: bank.pageIndex,
        name: bank.name,
        isEmergency: bank.isEmergency,
      });
    }

    const pads = await db
      .transaction("padConfigurations")
      .store.index("profileId")
      .getAll(sourceProfileId);
    for (const pad of pads) {
      await upsertPadConfiguration({
        profileId: newProfileId,
        bankId: pad.bankId,
        padIndex: pad.padIndex,
        // The key binding belongs to the pad position, not to its contents,
        // but a duplicate keeps the whole layout, so it comes along.
        keyBinding: pad.keyBinding,
        // Everything else comes through the helper rather than by hand. This
        // used to list the fields it knew about and silently dropped
        // `audioGainSettings` and `padGainDb`, so a duplicated profile played
        // at a different level from the one it was copied from. The copy
        // references the same audio rows, so the ids the settings are keyed by
        // still mean the same sounds.
        ...extractPadPlaybackSettings(pad),
      });
    }
  } catch (error) {
    // `deleteProfile` keeps audio that other profiles still reference, so
    // this cannot take the original's sounds with it.
    await deleteProfile(newProfileId).catch((cleanupError) => {
      console.error(
        `Could not remove the half-copied profile ${newProfileId}:`,
        cleanupError,
      );
    });
    throw error;
  }

  return newProfileId;
}
