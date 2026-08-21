/**
 * Export and import of individual banks.
 *
 * A bank archive is the profile archive with a different manifest version:
 * `manifest.json`, one `banks/<n>/bank.json` per bank, and one shared
 * `audio/<id>` folder. Five banks that share a sound store it once.
 *
 * The import is two-phase, because a bank has to be given a slot before
 * anything is written: `readArchiveManifest` answers "what is in this file",
 * the UI asks the user where each bank goes, and `importBanksFromZip` writes.
 *
 * ## What the writer guarantees, and what a reader may assume
 *
 * `exportBanksToZip` writes exactly these entries and no others:
 *
 * - `manifest.json` — a {@link BankZipManifest}. `folder` is the decimal
 *   index of the bank in the selection, so the entries are `banks/0`,
 *   `banks/1`, … in the order the user picked.
 * - `banks/<folder>/bank.json` — a {@link BankExport}, one per manifest
 *   entry, carrying no row identity and no sync stamps.
 * - `audio/<id>` — the raw bytes, STOREd rather than DEFLATEd, named by the
 *   audio row id of the *exporting* device. Every id any bank's `audioFiles`
 *   lists has one, and a sound several banks name has exactly one while each
 *   of those banks keeps its own reference to it.
 *
 * **A reader may assume none of that.** An archive arrives from a file
 * picker, so it is whatever the user dropped on the app — a profile archive,
 * a zip of holiday photos, a bank archive some later version wrote, or one
 * edited by hand. Everything below has to be checked rather than trusted:
 *
 * - that the file is a zip at all, that `manifest.json` exists, that it
 *   parses, and that `exportVersion` is 4 (a profile archive's manifest is
 *   version 3 and lists `profiles`);
 * - that `banks` is an array, and that each `folder` names an entry that
 *   exists — a manifest may list a folder with no `bank.json` behind it, and
 *   a `folder` is a *string from the file*, so `"../../.."` and a 4 MB name
 *   are both things it may say;
 * - that two manifest entries do not name one folder, and that no entry name
 *   is repeated — zip permits duplicate names;
 * - that `page`, `padConfigurations` and `audioFiles` are the shapes
 *   {@link BankExport} claims, that `padIndex` and every numeric field is a
 *   finite number in range, and that `name` is a string;
 * - that `sourceBankId` is a *comparison* key only. It is matched against ids
 *   the destination profile already holds and never adopted, which is what
 *   keeps a `#` in it out of a playback key;
 * - that an id in a pad's `audioFileIds` appears in that bank's `audioFiles`,
 *   and that an id in `audioFiles` has an `audio/<id>` entry — neither is
 *   guaranteed, and the importer already drops references it cannot map;
 * - that an entry is a plausible size before reading it into memory. The
 *   profile importer's `MAX_ZIP_METADATA_BYTES` is the existing answer for
 *   the JSON; audio is streamed, but `uncompressedSize` is still the
 *   archive's own claim rather than a measurement.
 *
 * An `audio/<id>` entry also says nothing about its own content: the media
 * type comes from the matching `audioFiles` reference, and the id in the
 * entry name is the exporting device's key, which the importer remaps.
 */

import { IDBPDatabase } from "idb";
import { TOTAL_PADS } from "./constants";
import {
  ImpAmpDBSchema,
  MAX_BANKS,
  PadConfiguration,
  PageMetadata,
  createBank,
  deleteUnreferencedAudioFiles,
  extractPadPlaybackSettings,
  getAllPageMetadataForProfile,
  getBankById,
  getPadConfigurationsForProfileBank,
  getProfile,
  upsertPadConfiguration,
  upsertPageMetadata,
  withAudioImportInProgress,
} from "./db";
import {
  ArchiveItem,
  AudioFileRef,
  ImportAudioSource,
  SerialisedLoudness,
  TransferProgressCallback,
  collectAudioForPads,
  getZipJs,
  importAudioSources,
  remapPadSettingsOnImport,
  reportPreparing,
  writeArchiveZip,
  zipEntryReaders,
} from "./importExport";

/**
 * What an exported row does not carry.
 *
 * The first four say where the row lived: `id` and `profileId` are this
 * device's database keys, `bankId` is an identity the import assigns for
 * itself, and `pageIndex` is a *position* — a bank's place belongs to the
 * profile holding it, so carrying it would invite an importer to place by it.
 *
 * The last three are sync bookkeeping. An archive is a document, not a sync
 * event: `_modified` and `_fieldsModified` describe when some other device
 * last touched each field, and a bank written into an existing, already
 * synced profile with a foreign device's stamps either loses the local edit
 * or manufactures a conflict on every field the two disagree about. The
 * writer stamps its own, exactly as the profile importer does.
 */
const ROW_FIELDS_NOT_EXPORTED = [
  "id",
  "profileId",
  "bankId",
  "pageIndex",
  "_created",
  "_modified",
  "_fieldsModified",
] as const;

type RowFieldNotExported = (typeof ROW_FIELDS_NOT_EXPORTED)[number];

/** A bank's own settings — its name and its emergency flag — and nothing else. */
export type BankExportPage = Omit<PageMetadata, RowFieldNotExported>;

/** A pad's content, keyed by the audio ids of the archive it travels in. */
export type BankExportPad = Omit<PadConfiguration, RowFieldNotExported>;

/**
 * Strips a stored row down to the content an archive carries.
 *
 * Subtractive on purpose. A whitelist would have to be extended for every
 * field added to a pad, and the fields that keep being added are exactly the
 * `Record<audioFileId, …>` ones CLAUDE.md warns about — `audioTrimSettings`
 * was missed by both the plan and the brief for the collapse that had to
 * remap it. Naming what must *not* travel is a list that stays short and
 * whose omissions are loud rather than silent.
 */
function withoutRowIdentity<T extends object>(
  row: T,
): Omit<T, RowFieldNotExported> {
  const content = { ...row } as Record<string, unknown>;
  for (const field of ROW_FIELDS_NOT_EXPORTED) delete content[field];
  return content as Omit<T, RowFieldNotExported>;
}

/** One bank, as it is written into `banks/<n>/bank.json`. */
export interface BankExport {
  exportVersion: 4;
  exportDate: string;
  /**
   * Identity of the bank this came from, for the update-in-place offer.
   *
   * Untrusted on the way back in, and it must stay a *comparison* key: the
   * import matches it against the ids the destination profile already holds
   * so it can preselect "replace that bank", and mints its own id when it
   * adds one. It is never adopted as a bank's identity, which is what keeps
   * an archive from injecting an id containing `#` — that would break
   * `baseKeyOf`'s playback-key parsing. `writeBankIntoProfile` owns that rule.
   */
  sourceBankId: string;
  /** pageIndex is not here: import chooses the position. */
  page: BankExportPage;
  padConfigurations: BankExportPad[];
  audioFiles: AudioFileRef[];
}

/**
 * Collects one bank and the audio its pads name.
 *
 * The bank is found by identity. `bankId` is what every database, sync,
 * playback and loading key uses; `pageIndex` is only the tab order and the
 * keyboard shortcut, and the two agree for a migrated or default bank, so a
 * position lookup would look correct on most profiles and hand back the wrong
 * bank on any profile whose tabs have been dragged.
 *
 * Audio comes back as a separate map rather than inline, because
 * `exportBanksToZip` shares one `audio/<id>` folder across every bank in the
 * archive.
 */
export async function collectBankDataForZip(
  profileId: number,
  bankId: string,
): Promise<{
  bank: BankExport;
  audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
  sourceProfileName: string;
}> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw new Error(`Profile with ID ${profileId} not found`);
  }

  const page = await getBankById(profileId, bankId);
  if (!page) {
    throw new Error(`Bank ${bankId} not found in profile ${profileId}`);
  }

  // Ranges the profileBankPad index rather than filtering every pad in the
  // profile: a second copy of "which pads belong to this bank" would be free
  // to drift from the one the app plays from.
  const pads = await getPadConfigurationsForProfileBank(profileId, bankId);
  const { audioFiles, audioBlobs } = await collectAudioForPads(pads);

  return {
    bank: {
      exportVersion: 4,
      exportDate: new Date().toISOString(),
      sourceBankId: bankId,
      page: withoutRowIdentity(page),
      padConfigurations: pads.map(withoutRowIdentity),
      audioFiles,
    },
    audioBlobs,
    sourceProfileName: profile.name,
  };
}

/**
 * The manifest at the root of a bank archive.
 *
 * `exportVersion: 4` is what tells a reader this is a bank archive at all: a
 * profile archive's manifest is version 3 and lists `profiles`, and the two
 * must never share a number.
 *
 * `sourceProfileName` is per bank rather than per archive because a later
 * version may well let one archive hold banks from several profiles, and it
 * is what the placement dialog shows to distinguish two banks both called
 * "Stings".
 */
export interface BankZipManifest {
  exportVersion: 4;
  exportDate: string;
  banks: { name: string; folder: string; sourceProfileName: string }[];
}

/**
 * Exports banks as a `.iaz` archive: `manifest.json`, one
 * `banks/<n>/bank.json` per bank, and one shared `audio/<id>` folder.
 *
 * The bytes of a sound several banks name are written once — five banks that
 * all open with the same sting cost one copy of it — while each bank.json
 * keeps its own reference to that id, so a bank still stands alone when it is
 * written into a profile.
 *
 * A bank that cannot be collected fails the whole export, which is the
 * opposite of what `exportProfilesToZip` does with a profile. The reasoning is
 * the user rather than the code: a profile export is a backup of everything,
 * and one missing profile is better than no file at all; a bank export is a
 * handful of banks named by hand, and an archive quietly short of one of them
 * is discovered at the far end, by someone who no longer has the source.
 *
 * It does **not** stamp `lastBackedUpAt`. A selection of banks is not a backup
 * of the profile, and a claim otherwise would silence the backup reminder on
 * data nobody exported.
 *
 * @param profileId The profile the banks come from
 * @param bankIds Which banks to write, by identity, in the order they appear
 * @param target A WritableStream to stream to disk, or "blob"
 * @param onProgress Optional progress callback for the audio phase
 * @returns The archive Blob when target is "blob", otherwise null
 */
export async function exportBanksToZip(
  profileId: number,
  bankIds: string[],
  target: WritableStream | "blob",
  onProgress?: TransferProgressCallback,
): Promise<Blob | null> {
  reportPreparing(onProgress);

  const manifestBanks: BankZipManifest["banks"] = [];
  const items: ArchiveItem[] = [];

  for (let i = 0; i < bankIds.length; i++) {
    const { bank, audioBlobs, sourceProfileName } = await collectBankDataForZip(
      profileId,
      bankIds[i],
    );
    // The folder is the position in `bankIds`, not anything derived from the
    // bank: `sourceBankId` is a comparison key the importer must be free to
    // ignore, and an id is not a safe path component in the first place.
    const folder = String(i);
    manifestBanks.push({ name: bank.page.name, folder, sourceProfileName });
    items.push({
      path: `banks/${folder}/bank.json`,
      json: JSON.stringify(bank, null, 2),
      audioBlobs,
    });
  }

  const manifest: BankZipManifest = {
    exportVersion: 4,
    exportDate: new Date().toISOString(),
    banks: manifestBanks,
  };

  return writeArchiveZip(target, manifest, items, onProgress);
}

/** What the placement dialog shows for one bank in an archive. */
export interface BankSummary {
  /** The archive folder, and the key of the placement map. */
  folder: string;
  name: string;
  isEmergency: boolean;
  padCount: number;
  audioCount: number;
  sourceProfileName: string;
  /**
   * The archive's claim about where this bank came from — a comparison key.
   *
   * Carried **verbatim**, and deliberately not cleaned, trimmed or validated.
   * Its only use is `=== ` against the bank ids the destination profile
   * already holds, so that the dialog can offer "replace that bank"; nothing
   * adopts it as an identity, and `writeBankIntoProfile` mints its own id
   * when it adds a bank. A sanitised value would look adoptable, and an
   * adopted id containing `#` would break `baseKeyOf`'s playback-key parsing.
   *
   * An archive that does not say, or says something that is not a string,
   * gets `""` — which equals no bank id any profile holds, so the offer
   * simply does not appear.
   */
  sourceBankId: string;
}

/** What an archive turned out to be. */
export type ArchiveDescription =
  { kind: "profiles" } | { kind: "banks"; banks: BankSummary[] };

/**
 * The only folder names this format defines: the decimal index of the bank in
 * the selection, as `exportBanksToZip` writes it.
 *
 * `folder` is a string out of the file. It is concatenated into an entry path
 * and it is the key of the placement map the dialog builds, so an archive is
 * otherwise free to say `"../../.."`, `""`, or two hundred kilobytes of
 * digits. Nine digits is far past any real selection and keeps the string
 * short enough to put in a message.
 */
const BANK_FOLDER_PATTERN = /^\d{1,9}$/;

/** How much of an untrusted string to put in an error message. */
const MAX_FOLDER_IN_MESSAGE = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A folder name as it can safely be shown: short, and quoted. */
function describeFolder(value: unknown): string {
  if (typeof value !== "string") return `${typeof value}`;
  return value.length > MAX_FOLDER_IN_MESSAGE
    ? `"${value.slice(0, MAX_FOLDER_IN_MESSAGE)}..."`
    : `"${value}"`;
}

/**
 * Checks the manifest's bank list without reading a single bank entry.
 *
 * Two passes rather than one, because the second pass reads from the archive:
 * every folder is checked and every duplicate refused before any entry is
 * opened, so the work an archive can ask for is bounded by the number of
 * distinct folders it names rather than by the length of its list.
 */
function listedBanks(
  banks: unknown[],
): { folder: string; sourceProfileName: string }[] {
  const listed: { folder: string; sourceProfileName: string }[] = [];
  const seen = new Set<string>();

  for (const entry of banks) {
    const folder = isRecord(entry) ? entry.folder : undefined;
    if (typeof folder !== "string" || !BANK_FOLDER_PATTERN.test(folder)) {
      throw new Error(
        `This archive names ${describeFolder(folder)}, which is not a bank folder this format uses.`,
      );
    }
    if (seen.has(folder)) {
      throw new Error(
        `This archive's manifest lists banks/${folder} twice, so there is no telling which bank is which.`,
      );
    }
    seen.add(folder);

    // A name shown to the user, so it has to be text or nothing. The bank's
    // own name comes from `bank.json`; only the profile's name lives here.
    const sourceProfileName = isRecord(entry) ? entry.sourceProfileName : "";
    listed.push({
      folder,
      sourceProfileName:
        typeof sourceProfileName === "string" ? sourceProfileName : "",
    });
  }

  return listed;
}

/**
 * Describes one `bank.json`, from the document rather than from the manifest.
 *
 * The manifest carries a copy of the bank's name, and it is not the copy that
 * gets written into the profile — so a dialog built from it could show a name
 * the import will not use. `bank.json` is the authority for everything except
 * the source profile's name, which only the manifest holds.
 */
function summariseBank(
  path: string,
  folder: string,
  sourceProfileName: string,
  value: unknown,
): BankSummary {
  const page = isRecord(value) ? value.page : undefined;
  if (!isRecord(page) || typeof page.name !== "string") {
    throw new Error(`${path} does not describe a bank: it has no page name.`);
  }
  const padConfigurations = (value as Record<string, unknown>)
    .padConfigurations;
  if (!Array.isArray(padConfigurations)) {
    throw new Error(
      `${path} does not describe a bank: its padConfigurations is not a list.`,
    );
  }
  const audioFiles = (value as Record<string, unknown>).audioFiles;
  if (!Array.isArray(audioFiles)) {
    throw new Error(
      `${path} does not describe a bank: its audioFiles is not a list.`,
    );
  }

  const sourceBankId = (value as Record<string, unknown>).sourceBankId;
  return {
    folder,
    name: page.name,
    // A flag, not anything truthy: `"no"` out of a hand-edited archive must
    // not turn a bank into an emergency bank.
    isEmergency: page.isEmergency === true,
    // What the documents say, which is all that can honestly be reported
    // before anything is extracted. A pad may name a sound `audioFiles`
    // never declares, and a declared sound may have no bytes behind it —
    // both come out of this app's own writer, because `collectAudioForPads`
    // skips a dead audio row and leaves the pad's reference alone.
    padCount: padConfigurations.length,
    audioCount: audioFiles.length,
    sourceProfileName,
    sourceBankId: typeof sourceBankId === "string" ? sourceBankId : "",
  };
}

/**
 * Says what an archive holds, without a write of any kind.
 *
 * The manifest version routes the file, so the `.iaz` extension and the file
 * input's accept list stay as they are. The bank entries are read too, since
 * the manifest alone cannot report a pad count or an emergency flag; those
 * are small JSON documents under the same size cap `importProfilesFromZip`
 * uses, and no `audio/` entry is touched.
 *
 * This is the first code in this feature to parse a file the user picked, so
 * it assumes nothing the module comment above says a reader may not assume.
 * Where a judgement is the profile importer's to make it is left to it: a
 * version 3 manifest is reported as a profile archive without checking its
 * `profiles` list, and an empty `manifest.json` falls through to
 * `profile.json` exactly as that importer's own truthiness test does — a
 * describer that disagreed with the importer would refuse files that import
 * perfectly well, or promise ones that do not.
 */
export async function readArchiveManifest(
  blob: Blob,
): Promise<ArchiveDescription> {
  const zipjs = await getZipJs();
  const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(blob));

  try {
    const described = await readBankArchive(
      zipEntryReaders(await zipReader.getEntries()),
    );
    return described.kind === "banks"
      ? { kind: "banks", banks: described.banks.map((held) => held.summary) }
      : described;
  } finally {
    await zipReader.close();
  }
}

/** The readers `zipEntryReaders` hands back, named so it can be passed on. */
type ZipEntryReaders = ReturnType<typeof zipEntryReaders>;

/** One bank of an archive: what to show about it, and what it holds. */
interface LoadedBank {
  summary: BankSummary;
  bank: BankExport;
}

/**
 * Reads and checks every document in a bank archive — the shared half of
 * "what is this file" and "write it into this profile".
 *
 * Both callers need the same manifest routing and the same per-bank checks,
 * and they cannot share a *parse*: the two phases are separated by the user
 * answering a dialog, so the importer opens the file again from scratch.
 * What they can share is the rule, which is this function, so a document the
 * describer accepted cannot be one the importer reads differently.
 *
 * The importer keeps the parsed documents; `readArchiveManifest` throws them
 * away. `bank` is only as trustworthy as {@link summariseBank} makes it: a
 * page with a name, and `padConfigurations` and `audioFiles` that are lists.
 * Everything inside those lists is still whatever the file said, which is why
 * `writeBankIntoProfile` checks each pad and this module checks each sound
 * reference.
 */
async function readBankArchive(
  readers: ZipEntryReaders,
): Promise<{ kind: "profiles" } | { kind: "banks"; banks: LoadedBank[] }> {
  const { readEntryText, parseEntryJson } = readers;

  const manifestText = await readEntryText("manifest.json");
  if (!manifestText) {
    if (await readEntryText("profile.json")) return { kind: "profiles" };
    throw new Error("Invalid .iaz file: missing manifest.json or profile.json");
  }

  const manifest = parseEntryJson("manifest.json", manifestText);
  if (isRecord(manifest) && manifest.exportVersion === 3) {
    return { kind: "profiles" };
  }
  if (
    !isRecord(manifest) ||
    manifest.exportVersion !== 4 ||
    !Array.isArray(manifest.banks)
  ) {
    throw new Error("Invalid or unsupported .iaz archive format.");
  }

  const banks: LoadedBank[] = [];
  for (const listed of listedBanks(manifest.banks)) {
    const path = `banks/${listed.folder}/bank.json`;
    const text = await readEntryText(path);
    if (text === null) {
      throw new Error(
        `This archive's manifest lists ${path}, but the archive does not contain it.`,
      );
    }
    const document = parseEntryJson(path, text);
    banks.push({
      summary: summariseBank(
        path,
        listed.folder,
        listed.sourceProfileName,
        document,
      ),
      bank: document as BankExport,
    });
  }

  return { kind: "banks", banks };
}

/** Where one incoming bank goes in the destination profile. */
export type BankPlacement =
  { kind: "add" } | { kind: "replace"; bankId: string } | { kind: "skip" };

/** What one bank write did. */
export interface BankWriteOutcome {
  written: boolean;
  bankId?: string;
  pageIndex?: number;
  /**
   * The audio rows this write **created**, and never one it reused.
   *
   * The rollback deletes from this list, and a reused row is one another
   * profile is very probably already playing — deleting it is the data loss
   * `addOrReuseAudioFile`'s `reused` flag exists to prevent.
   */
  createdAudioIds: number[];
}

/**
 * A bank write that failed, carrying the audio it had already created.
 *
 * Without this the rows written before the failing sound are unreachable: the
 * caller has no return value to read them off, `deleteProfile` cannot find
 * them because no pad names them, and they sit in the library until somebody
 * presses the orphan cleanup button. The list is the same created-not-reused
 * list a successful write returns, so the rollback treats both the same way.
 */
export class BankWriteError extends Error {
  readonly createdAudioIds: number[];

  constructor(
    message: string,
    createdAudioIds: number[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BankWriteError";
    this.createdAudioIds = createdAudioIds;
  }
}

/**
 * A pad from an archive, with every value that could damage a write replaced.
 *
 * The spread is deliberate and is the same argument `withoutRowIdentity`
 * makes in the other direction: the archive is subtractive, so a field added
 * to a pad after this was written still arrives, and copying the row wholesale
 * is what lets it. What reaches the database is then narrowed by
 * `extractPadPlaybackSettings`, which is a `Pick` — so a field this app does
 * not know is carried *here* and dropped *there*, and the moment
 * `PadPlaybackSettings` gains a member every copying site gets it at once.
 *
 * Only the values that can do harm are overridden, and each for a reason:
 *
 * - `padIndex` is a component of the `profileBankPad` key. A string, a
 *   fraction or a `NaN` is a `DataError` partway through a write, or a pad
 *   filed at a position no grid shows — so it is refused outright rather than
 *   normalised, and refused before any audio is written.
 * - `padGainDb` reaches the gain node. `"loud"` becomes `NaN` there and
 *   throws at trigger time, on stage.
 * - `isDisabled` is a flag: `"no"` must not disable a pad.
 * - the two `Record<audioFileId, …>` maps and `audioFileIds` are read by the
 *   remap below, which would otherwise iterate a string or throw on `.map`.
 *
 * `playbackType` and `activePadBehavior` are deliberately **not** checked
 * against their unions. `getStrategy` already falls back to sequential for a
 * value it does not know and `resolveActivePadBehavior` falls back to the
 * profile's, and a runtime copy of either union here is exactly the duplicated
 * rule this repo regresses on — CLAUDE.md records `ActivePadBehavior` having
 * been written out in four places once.
 */
type IncomingPad = Partial<PadConfiguration> & { padIndex: number };

function readIncomingPad(value: unknown): IncomingPad {
  if (!isRecord(value)) {
    throw new BankWriteError(
      `This bank has an entry in padConfigurations that is not a pad.`,
      [],
    );
  }

  const padIndex = value.padIndex;
  if (
    typeof padIndex !== "number" ||
    !Number.isInteger(padIndex) ||
    padIndex < 0 ||
    padIndex >= TOTAL_PADS
  ) {
    const shown = typeof padIndex === "number" ? padIndex : typeof padIndex;
    throw new BankWriteError(
      `This bank has a pad at position ${shown}, and a bank has ${TOTAL_PADS} pads numbered from 0.`,
      [],
    );
  }

  return {
    ...value,
    padIndex,
    keyBinding:
      typeof value.keyBinding === "string" ? value.keyBinding : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    audioFileIds: incomingAudioIds(value),
    audioTrimSettings: isRecord(value.audioTrimSettings)
      ? (value.audioTrimSettings as PadConfiguration["audioTrimSettings"])
      : undefined,
    audioGainSettings: isRecord(value.audioGainSettings)
      ? (value.audioGainSettings as PadConfiguration["audioGainSettings"])
      : undefined,
    padGainDb:
      typeof value.padGainDb === "number" && Number.isFinite(value.padGainDb)
        ? value.padGainDb
        : undefined,
    isDisabled: value.isDisabled === true,
  } as IncomingPad;
}

/**
 * The sounds a pad names, in order, from either spelling.
 *
 * `audioFileId` is the pre-V3 scalar. `migrateStoreV4` was meant to convert
 * every one of them and demonstrably did not — it swallows per-record errors,
 * which is why `collectReferencedAudioFileIds` still reads it and why the
 * collapse had to remap it. The export is subtractive so such a pad carries
 * the scalar into the archive, and `collectAudioForPads` reads that spelling
 * too, so the bytes are in the archive to attach: reading only `audioFileIds`
 * here would write the pad with no sound at all and delete nothing loudly.
 *
 * Not `collectReferencedAudioFileIds` itself, which returns a `Set` over many
 * pads: a pad's sound *order* is what sequential playback plays in.
 */
function incomingAudioIds(pad: Record<string, unknown>): number[] {
  const ids = Array.isArray(pad.audioFileIds)
    ? pad.audioFileIds.filter((id): id is number => Number.isInteger(id))
    : [];
  const legacy = pad.audioFileId;
  if (Number.isInteger(legacy) && !ids.includes(legacy as number)) {
    ids.push(legacy as number);
  }
  return ids;
}

/**
 * Writes one bank into a profile.
 *
 * "add" mints a fresh `bankId` and takes the first free position. "replace"
 * keeps the destination's `bankId` and its position, clears its pads and
 * writes the incoming ones, so identity survives and a later merge reads a
 * content change rather than a new bank. "skip" writes nothing — including
 * no audio, since a row nothing references and nobody was told about is an
 * orphan the caller cannot roll back.
 *
 * **`bank.sourceBankId` is never read here.** That is the whole of the rule:
 * an "add" takes its identity from `createBank`, which mints a UUID, and a
 * "replace" takes it from `mode.bankId`, which the dialog sourced from the
 * *destination* profile and which is checked against that profile before
 * anything is written. So no string out of the archive can become a bank id,
 * and a `sourceBankId` of `"raid#7"` cannot reach `baseKeyOf` — which splits a
 * playback key at the last `#` followed by digits — and silently merge every
 * pad on the bank onto one base key.
 *
 * Sync stamps are minted, not carried. `upsertPageMetadata`,
 * `upsertPadConfiguration` and `createBank` each stamp `_created`,
 * `_modified` and `_fieldsModified` from this device's clock, and none of them
 * accepts the archive's: writing a bank into an already-synced profile with a
 * foreign device's per-field stamps either loses the local edit or puts a
 * conflict modal in front of the user for every field the two disagree about.
 *
 * Audio ids are remapped through `importAudioSources` and
 * `remapPadSettingsOnImport`, never by hand. Reuse by content hash means a
 * bank imported back into the profile it came from adds no blobs at all, and
 * an id the caller supplies no source for — a pad naming a sound the archive
 * never declared, or a declared sound whose bytes are missing, both of which
 * this app's own writer produces — is simply dropped from the pad's
 * references and from its trim and gain maps. A source that *fails* is a
 * different thing and fails the bank: an archive that promised bytes and could
 * not deliver them would otherwise arrive silently one sound short, at the far
 * end, in front of someone who no longer has the source.
 *
 * Two things it deliberately does not do. It does not clean up the audio a
 * replaced bank's old pads named, because those rows may be shared and
 * `deleteUnreferencedAudioFiles` is the only thing entitled to decide that.
 * And it does not snapshot the bank it replaces: the pads are cleared in one
 * transaction and written in others, so a failure between them leaves the
 * bank empty, and restoring it is the caller's — `importBanksFromZip`'s —
 * job, which is where the snapshot of every replace target belongs.
 *
 * @returns Which bank it wrote, and the audio rows it created — the rollback
 *   deletes from that list and leaves every reused row alone
 * @throws {BankWriteError} carrying the same created-not-reused list
 */
export function writeBankIntoProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  args: {
    profileId: number;
    mode: BankPlacement;
    bank: BankExport;
    audioSources: ImportAudioSource[];
  },
): Promise<BankWriteOutcome> {
  if (args.mode.kind === "skip") {
    return Promise.resolve({ written: false, createdAudioIds: [] });
  }
  // Declared to the orphan sweeps for the whole write. The audio goes in
  // first and the pads that name it several steps later — it cannot be
  // otherwise, since a pad names its sounds by the ids the store assigns — so
  // in between there are rows nothing references, which is precisely what
  // `cleanupOrphanedAudioFiles` deletes.
  return withAudioImportInProgress(() => runBankWrite(db, args));
}

async function runBankWrite(
  db: IDBPDatabase<ImpAmpDBSchema>,
  {
    profileId,
    mode,
    bank,
    audioSources,
  }: {
    profileId: number;
    mode: BankPlacement;
    bank: BankExport;
    audioSources: ImportAudioSource[];
  },
): Promise<BankWriteOutcome> {
  if (mode.kind === "skip") return { written: false, createdAudioIds: [] };

  // Everything that can refuse the bank happens before anything is written,
  // so a corrupt archive costs no audio rows and needs no rollback. These
  // checks repeat some of `readArchiveManifest`'s deliberately: this function
  // is also the seam an in-app "merge that profile into this one" would call,
  // and it does not get to assume a parser ran first.
  const page = isRecord(bank.page) ? bank.page : undefined;
  if (typeof page?.name !== "string") {
    throw new BankWriteError(`This bank has no name, so it is not a bank.`, []);
  }
  const pageName = page.name;
  // A flag, not anything truthy: a hand-edited `"yes"` must not make a bank
  // answer the emergency key.
  const isEmergency = page.isEmergency === true;
  const incomingPads = (
    Array.isArray(bank.padConfigurations) ? bank.padConfigurations : []
  ).map(readIncomingPad);

  // The placement, read-only. A replace target names a bank in the
  // *destination* profile, and bank identity is per profile, so this both
  // resolves the position and is the check that the id is one of ours.
  const target =
    mode.kind === "replace"
      ? await getBankById(profileId, mode.bankId)
      : undefined;
  if (mode.kind === "replace" && !target) {
    throw new BankWriteError(
      `Bank ${mode.bankId} is no longer in this profile.`,
      [],
    );
  }

  const now = new Date();
  const { audioIdMap, createdIds, failures } = await importAudioSources(
    db,
    audioSources,
    now,
  );
  if (failures.length > 0) {
    const names = failures.map((failure) => failure.name).join("; ");
    throw new BankWriteError(
      `${failures.length} of ${audioSources.length} sounds could not be imported (${names}).`,
      createdIds,
      { cause: failures[0].error },
    );
  }

  try {
    let bankId: string;
    let pageIndex: number;

    if (target) {
      bankId = target.bankId;
      pageIndex = target.pageIndex;

      // Clear the pads first. A pad the incoming bank does not define has to
      // go, or the replaced bank keeps sounds from the bank it replaced. By
      // bank rather than by profile: the profile's other banks are not part
      // of this.
      const existingPads = await getPadConfigurationsForProfileBank(
        profileId,
        bankId,
      );
      const tx = db.transaction("padConfigurations", "readwrite");
      const store = tx.objectStore("padConfigurations");
      for (const pad of existingPads) {
        if (pad.id !== undefined) await store.delete(pad.id);
      }
      await tx.done;

      // No `pageIndex`: the bank exists and its position belongs to the
      // profile holding it, so passing one back would be the importer placing
      // by position after all.
      await upsertPageMetadata({
        profileId,
        bankId,
        name: pageName,
        isEmergency,
      });
    } else {
      // createBank owns the cap check, the free-slot search, the new id and
      // the initial sync fields. A second copy of those four rules here would
      // drift from it, and it would also drop the sync fields.
      const created = await createBank(profileId, pageName, isEmergency);
      bankId = created.bankId;
      pageIndex = created.pageIndex;
    }

    for (const pad of incomingPads) {
      const audioFileIds = pad
        .audioFileIds!.map((originalId) => audioIdMap.get(originalId))
        .filter((newId): newId is number => newId !== undefined);

      await upsertPadConfiguration({
        profileId,
        bankId,
        padIndex: pad.padIndex,
        keyBinding: pad.keyBinding,
        // Through the shared helper, so a new pad field cannot be dropped here
        // without being dropped everywhere at once — and so that `id`,
        // `profileId`, `bankId` and the archive's sync stamps cannot ride in
        // on the spread above. An `id` that did would put this pad on top of
        // whatever row already holds that key, in whatever profile.
        ...extractPadPlaybackSettings({
          ...pad,
          audioFileIds,
          audioTrimSettings: remapPadSettingsOnImport(
            pad.audioTrimSettings,
            audioIdMap,
          ),
          audioGainSettings: remapPadSettingsOnImport(
            pad.audioGainSettings,
            audioIdMap,
          ),
        }),
      });
    }

    return { written: true, bankId, pageIndex, createdAudioIds: createdIds };
  } catch (error) {
    // Everything from here on can still fail — `createBank` refuses a
    // twenty-first bank, and a pad write can throw — and the audio is already
    // in the library by then.
    throw new BankWriteError(
      error instanceof Error ? error.message : String(error),
      createdIds,
      { cause: error },
    );
  }
}

/** What one import of an archive's banks did. */
export interface BankImportResult {
  written: {
    folder: string;
    name: string;
    bankId: string;
    pageIndex: number;
  }[];
  /** The names of the banks the placement map did not ask for. */
  skipped: string[];
}

/** Every row of one bank, as it stood before the import touched it. */
interface BankSnapshot {
  page: PageMetadata | undefined;
  pads: PadConfiguration[];
}

/**
 * The profile as it stood before the first bank was written.
 *
 * `bankIds` is a *set of identities* rather than a list of what this run
 * added, and that distinction is the whole of the rollback: a write that
 * failed between `createBank` and its first pad has already put a bank in the
 * profile and has no return value to say so — its `BankWriteError` carries
 * audio ids, not a bank id — so a rollback driven by what succeeded leaves a
 * stray empty bank behind for ever.
 */
interface ImportBaseline {
  bankIds: Set<string>;
  snapshots: Map<string, BankSnapshot>;
}

/**
 * Where the caller wants one bank.
 *
 * A folder nothing is said about is a **skip**, not an add. The map comes
 * from a dialog the user filled in, and a bank they did not answer for is one
 * they did not ask for; defaulting the other way would write banks nobody
 * chose into their profile.
 *
 * `folder` matched `/^\d{1,9}$/` before it ever reached here — `listedBanks`
 * refuses anything else — so the only strings that index this map are decimal
 * indexes, and an archive cannot name `constructor` and pull a placement out
 * of `Object.prototype`.
 */
function placementFor(
  placements: Record<string, BankPlacement>,
  folder: string,
): BankPlacement {
  return placements[folder] ?? { kind: "skip" };
}

/**
 * One archive sound, as the audio importer takes it — or nothing.
 *
 * Every field here is a value out of a file the user picked, so every field
 * is checked. `hash` matters most, and not for the reason it first looks: it
 * becomes an IndexedDB key on the way in, and the specification's answer to
 * an invalid one is a `DataError` that would fail the bank — but measured
 * here, `index.getAll({…})` answers with *every row in the library*, so the
 * archive's sound is silently "reused" as whatever unrelated row comes back
 * first and the pad plays someone else's audio. That is the same
 * collapse-to-one-key shape `findAudioFileIdByHashIn`'s own empty-hash guard
 * exists for. A hash is *trusted rather than verified* on purpose — it is
 * what lets a sound already in the library be reused before its bytes are
 * extracted at all — which is exactly why its type has to be real.
 *
 * A reference with no `audio/<id>` entry behind it is dropped rather than
 * fatal, and so is one that is not a reference at all. The first comes out of
 * this app's own writer whenever `collectAudioForPads` meets a pad naming an
 * audio row that has since gone; `writeBankIntoProfile` then drops the pad's
 * reference to it and writes the rest of the pad. A source that *fails* is a
 * different thing entirely and fails its bank.
 */
function audioSourceFor(
  ref: unknown,
  bankName: string,
  readers: ZipEntryReaders,
  zipjs: Awaited<ReturnType<typeof getZipJs>>,
): ImportAudioSource | null {
  if (!isRecord(ref) || !Number.isInteger(ref.id)) {
    console.warn(
      `Bank "${bankName}" lists something in audioFiles that is not a sound reference.`,
    );
    return null;
  }

  const originalId = ref.id as number;
  const entry = readers.entryByName.get(`audio/${originalId}`);
  if (!entry || entry.directory) {
    console.warn(
      `Audio file ${originalId} referenced by bank "${bankName}" is not in this archive.`,
    );
    return null;
  }

  const type =
    typeof ref.type === "string" ? ref.type : "application/octet-stream";
  const getData = entry.getData.bind(entry);
  return {
    originalId,
    name: typeof ref.name === "string" ? ref.name : `Sound ${originalId}`,
    type,
    size: entry.uncompressedSize,
    loudness: isRecord(ref.loudness)
      ? (ref.loudness as unknown as SerialisedLoudness)
      : undefined,
    hash: typeof ref.hash === "string" ? ref.hash : undefined,
    getBlob: () => getData(new zipjs.BlobWriter(type)),
  };
}

/**
 * Writes an archive's banks into one profile.
 *
 * Two-phase on purpose: `readArchiveManifest` answers "what is in this file",
 * the user gives each bank a slot, and this writes. A bank cannot be written
 * before its slot is known, and the file is opened again here because the
 * answer arrives from a dialog rather than from the same turn.
 *
 * ## What only this function can decide
 *
 * `writeBankIntoProfile` sees one bank at a time, so everything about the
 * *set* is decided here and before the first write: that the adds fit in the
 * free slots (`createBank` would refuse the last one halfway through
 * otherwise), and that no two banks are pointed at the same replace target
 * (the second would silently overwrite the first, with nothing left to tell
 * the user). What one bank can decide for itself is left to it — a replace
 * target that this profile does not hold is `writeBankIntoProfile`'s check,
 * and a second copy of it here is the duplicated rule this repo regresses on.
 *
 * ## A failure takes the whole import back
 *
 * Partial success is not offered, and the reason is the user rather than the
 * code. A replace has already cleared the destination bank by the time
 * anything can go wrong, so leaving the set half-applied means the pads of a
 * bank they still have are simply gone. An add mints a fresh bank id, so
 * "just run it again" after a partial success duplicates every bank that
 * landed — and the dialog places banks by archive folder, so there is no way
 * for the user to ask for "only the ones that failed". One gesture, one
 * outcome.
 *
 * The rollback puts every replaced bank back row for row and deletes every
 * bank the profile did not hold before, then deletes the audio rows *this
 * attempt created* — never one it reused, which is a row another profile is
 * very probably already playing. The created-not-reused list comes from
 * `writeBankIntoProfile`, both from what it returns and from the
 * `BankWriteError` it throws: the rows a failing bank wrote before it failed
 * are reachable no other way.
 *
 * Audio is written inside `withAudioImportInProgress` — by
 * `writeBankIntoProfile`, once per bank, which is enough. Between two banks
 * every sound already written is named by the pads of the bank that brought
 * it, so an orphan sweep landing in that gap has nothing to take. That is
 * also why `onProgress` is called *outside* the write it announces: a sweep
 * fired from a progress callback inside that scope would wait for an import
 * that is waiting for the callback.
 *
 * @param blob The archive, as picked
 * @param db An open connection, shared with `writeBankIntoProfile`
 * @param options The destination profile, and where each archive folder goes
 * @param onProgress Optional progress callback, one step per bank written
 */
export async function importBanksFromZip(
  blob: Blob,
  db: IDBPDatabase<ImpAmpDBSchema>,
  options: { profileId: number; placements: Record<string, BankPlacement> },
  onProgress?: TransferProgressCallback,
): Promise<BankImportResult> {
  const { profileId, placements } = options;
  reportPreparing(onProgress);

  const zipjs = await getZipJs();
  const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(blob));
  const createdAudioIds: number[] = [];
  // Null until the profile has been read. A rollback with no baseline would
  // read "this profile held no banks" and delete every bank in it, so a
  // failure before this point must not reach one.
  let baseline: ImportBaseline | null = null;

  try {
    const readers = zipEntryReaders(await zipReader.getEntries());
    const described = await readBankArchive(readers);
    if (described.kind !== "banks") {
      throw new Error(
        "This archive holds profiles, not banks. Import it from the profile manager instead.",
      );
    }

    // Every sound of every bank being written, resolved to an archive entry
    // before anything is decided. The blobs are not extracted here — each
    // source is a closure over its entry — so this costs a map lookup per
    // sound and gives the progress bar a total that means something.
    const plan = described.banks.map(({ summary, bank }) => {
      const mode = placementFor(placements, summary.folder);
      const audioSources =
        mode.kind === "skip"
          ? []
          : (Array.isArray(bank.audioFiles) ? bank.audioFiles : [])
              .map((ref) => audioSourceFor(ref, summary.name, readers, zipjs))
              .filter((source): source is ImportAudioSource => source !== null);
      return { summary, bank, mode, audioSources };
    });

    const pages = await getAllPageMetadataForProfile(profileId);
    const freeSlots = Math.max(0, MAX_BANKS - pages.length);
    const wantedSlots = plan.filter(({ mode }) => mode.kind === "add").length;
    if (wantedSlots > freeSlots) {
      throw new Error(
        `This profile has ${freeSlots} free slot${freeSlots === 1 ? "" : "s"}, and the import needs ${wantedSlots}.`,
      );
    }

    const replacing = new Set<string>();
    for (const { mode } of plan) {
      if (mode.kind !== "replace") continue;
      if (replacing.has(mode.bankId)) {
        throw new Error(
          "Two of these banks are set to replace the same bank, and the second would overwrite the first.",
        );
      }
      replacing.add(mode.bankId);
    }

    // The pads of the whole profile once, partitioned — rather than one
    // indexed read per replace target. An import can replace many banks.
    const allPads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const snapshots = new Map<string, BankSnapshot>();
    for (const bankId of replacing) {
      snapshots.set(bankId, {
        page: pages.find((page) => page.bankId === bankId),
        pads: allPads.filter((pad) => pad.bankId === bankId),
      });
    }
    baseline = {
      bankIds: new Set(pages.map((page) => page.bankId)),
      snapshots,
    };

    const toWrite = plan.filter(({ mode }) => mode.kind !== "skip");
    const totalBytes = toWrite.reduce(
      (total, { audioSources }) =>
        total +
        audioSources.reduce((sum, source) => sum + (source.size ?? 0), 0),
      0,
    );

    const written: BankImportResult["written"] = [];
    const skipped: string[] = [];
    let doneBytes = 0;

    for (const { summary, bank, mode, audioSources } of plan) {
      if (mode.kind === "skip") {
        skipped.push(summary.name);
        continue;
      }

      onProgress?.({
        phase: "audio",
        fileName: summary.name,
        processedFiles: written.length,
        totalFiles: toWrite.length,
        processedBytes: doneBytes,
        totalBytes,
      });

      try {
        const outcome = await writeBankIntoProfile(db, {
          profileId,
          mode,
          bank,
          audioSources,
        });
        createdAudioIds.push(...outcome.createdAudioIds);
        written.push({
          folder: summary.folder,
          name: summary.name,
          bankId: outcome.bankId!,
          pageIndex: outcome.pageIndex!,
        });
      } catch (error) {
        // A write that threw still wrote audio, and the error is the only
        // route back to it: nothing references those rows, so `deleteProfile`
        // cannot find them and only the orphan-cleanup button ever would.
        if (error instanceof BankWriteError) {
          createdAudioIds.push(...error.createdAudioIds);
        }
        throw error;
      }

      doneBytes += audioSources.reduce(
        (sum, source) => sum + (source.size ?? 0),
        0,
      );
    }

    onProgress?.({
      phase: "finalizing",
      processedFiles: written.length,
      totalFiles: toWrite.length,
      processedBytes: doneBytes,
      totalBytes,
    });

    return { written, skipped };
  } catch (error) {
    // Logged before the rollback, because a rollback that throws replaces
    // this error with its own — and "the profile could not be put back" is
    // the more urgent of the two, so it is the one that reaches the caller.
    console.error("Bank import failed:", error);
    if (baseline) await rollbackBankImport(db, profileId, baseline);
    if (createdAudioIds.length > 0) {
      try {
        await deleteUnreferencedAudioFiles(createdAudioIds);
      } catch (cleanupError) {
        console.error(
          "Failed to clean up audio files from the failed bank import:",
          cleanupError,
        );
      }
    }
    throw error;
  } finally {
    try {
      await zipReader.close();
    } catch {
      // Closing a reader that has already failed is not news.
    }
  }
}

/**
 * Puts the profile's banks back the way the baseline found them.
 *
 * Delete first, restore second, in one transaction over both stores, so there
 * is no moment at which a bank exists with neither its old pads nor its new
 * ones. A replaced bank's rows go back verbatim — the same records, under the
 * same keys, carrying the same sync stamps — so the next merge reads no
 * change at all rather than a rewrite by this device.
 *
 * What gets undone is "every bank this profile did not hold before", not
 * "every bank this run reported adding". See {@link ImportBaseline}: a bank
 * whose first pad write failed was added and never reported. The cost of that
 * choice is one tab wide — a bank created in *another* tab while the import
 * ran is also a bank this profile did not hold before — which is the same
 * limit `withAudioImportInProgress` documents, against an operation that is a
 * modal in the tab the user is looking at.
 */
async function rollbackBankImport(
  db: IDBPDatabase<ImpAmpDBSchema>,
  profileId: number,
  baseline: ImportBaseline,
): Promise<void> {
  const undo = (bankId: string): boolean =>
    !baseline.bankIds.has(bankId) || baseline.snapshots.has(bankId);

  const tx = db.transaction(["pageMetadata", "padConfigurations"], "readwrite");
  const pageStore = tx.objectStore("pageMetadata");
  const padStore = tx.objectStore("padConfigurations");

  let padCursor = await padStore.index("profileId").openCursor(profileId);
  while (padCursor) {
    if (undo(padCursor.value.bankId)) await padCursor.delete();
    padCursor = await padCursor.continue();
  }

  let pageCursor = await pageStore.index("profileId").openCursor(profileId);
  while (pageCursor) {
    if (undo(pageCursor.value.bankId)) await pageCursor.delete();
    pageCursor = await pageCursor.continue();
  }

  for (const snapshot of baseline.snapshots.values()) {
    if (snapshot.page) await pageStore.put(snapshot.page);
    for (const pad of snapshot.pads) await padStore.put(pad);
  }

  await tx.done;
}
