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

import {
  PadConfiguration,
  PageMetadata,
  getBankById,
  getPadConfigurationsForProfileBank,
  getProfile,
} from "./db";
import {
  ArchiveItem,
  AudioFileRef,
  TransferProgressCallback,
  collectAudioForPads,
  reportPreparing,
  writeArchiveZip,
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
