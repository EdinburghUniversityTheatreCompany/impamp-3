"use client";

/**
 * Where each bank of an archive goes, asked before anything is written.
 *
 * A bank cannot be written until it has a slot, so this stands between the
 * file input and `importBanksFromZip`. Everything it decides is a bank
 * **identity**, and nothing underneath it can tell that the wrong one was
 * named: a `replace` clears whatever bank it is handed and writes the
 * incoming bank over it. Five rules follow, and each is a test rather than a
 * preference.
 *
 *  - **The destination is the active profile, and is not offered as a
 *    choice.** A bank id means nothing outside its own profile, and the panel
 *    that reads the target's banks would have to re-read them for every
 *    switch. The board the user is looking at is the one they are importing
 *    into.
 *  - **The replace targets are the board's own list.** They come from
 *    `loadBankOptions`, which runs through `normaliseBankOrder`, so "3:" in
 *    this dropdown is "3:" on the tab strip. Two banks called "SFX" is
 *    ordinary, so the number is the only thing between them — the option
 *    *value* is the `bankId` and the number is what a person reads.
 *  - **The archive's own names are no better.** Two banks in one archive can
 *    share a name too, so the placement state is keyed by `folder` — the
 *    decimal index `readArchiveManifest` validated — and never by a name or
 *    by a row's position in this list.
 *  - **`sourceBankId` is compared, never adopted.** It picks the default
 *    placement by matching bank ids the *destination* already holds, and the
 *    id that ends up in a `replace` is that destination bank's own. Four
 *    tasks have kept the archive's string out of every key by construction.
 *  - **The import is all or nothing, and the dialog says so.** One bank
 *    failing takes the whole set back, because a `replace` has already
 *    cleared its destination and an `add` has already minted an id that
 *    re-running would duplicate. Nothing here may suggest that some banks
 *    landed and others did not.
 *
 * The capacity and duplicate-target checks below are also enforced inside
 * `importBanksFromZip`, and that is deliberate rather than duplicated logic:
 * the library's check is the guarantee, and these are what stop a person
 * pressing a button that cannot work. When the two ever disagree — another
 * tab adding a bank between the read and the press — the library wins and its
 * message is shown.
 */

import { useEffect, useState } from "react";
import { MAX_BANKS } from "@/lib/constants";
import {
  bankContents,
  bankDisplayName,
  bankLabel,
  loadBankOptions,
  type BankListOption,
} from "@/lib/bankSummaries";
import { count } from "@/lib/plural";
import TransferProgressBar from "./TransferProgressBar";
import type {
  BankImportResult,
  BankPlacement,
  BankSummary,
} from "@/lib/bankTransfer";
import type {
  TransferProgress,
  TransferProgressCallback,
} from "@/lib/importExport";

/** No rows: either nothing has been read yet, or the profile has no banks. */
const NO_OPTIONS: BankListOption[] = [];

/** The dropdown value for a placement. */
function placementValue(placement: BankPlacement): string {
  return placement.kind === "replace"
    ? `replace:${placement.bankId}`
    : placement.kind;
}

/**
 * The placement a dropdown value means.
 *
 * The bank id comes back out of the value it went in as, so it is always one
 * of the destination profile's own ids — the archive's `sourceBankId` has no
 * route into this.
 */
function placementFromValue(value: string): BankPlacement {
  if (value === "skip") return { kind: "skip" };
  if (value.startsWith("replace:")) {
    return { kind: "replace", bankId: value.slice("replace:".length) };
  }
  return { kind: "add" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A list of names, quoted, as a sentence fragment. */
function nameList(names: string[]): string {
  return names.map((name) => `“${name}”`).join(", ");
}

export default function BankImportPlacementDialog({
  archive,
  profileId,
  profileName,
  importBanksFromArchive,
  onBusyChange,
  onDismiss,
}: {
  /** The picked file, and what `readArchiveManifest` said is in it. */
  archive: { file: Blob; banks: BankSummary[] };
  /** The destination, always the active profile. */
  profileId: number;
  profileName: string;
  importBanksFromArchive: (
    file: Blob,
    profileId: number,
    placements: Record<string, BankPlacement>,
    onProgress?: TransferProgressCallback,
  ) => Promise<BankImportResult>;
  /** Lets the manager disable the file picker while a write is in flight. */
  onBusyChange: (busy: boolean) => void;
  onDismiss: () => void;
}) {
  const banks = archive.banks;
  // The destination's banks, with the profile they were read for. A read
  // takes a turn of the event loop, and the id in a `replace` has to have
  // come from the profile it is about to be applied to.
  const [loaded, setLoaded] = useState<{
    profileId: number | null;
    options: BankListOption[];
  }>({ profileId: null, options: NO_OPTIONS });
  // Only the answers the user actually gave. The rest is derived, so there is
  // no second copy of "what this row is set to" to fall out of step with the
  // defaults once the destination's banks arrive.
  const [chosen, setChosen] = useState<Record<string, BankPlacement>>({});
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BankImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const options = await loadBankOptions(profileId);
      if (!cancelled) setLoaded({ profileId, options });
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const isLoading = loaded.profileId !== profileId;
  const options = isLoading ? NO_OPTIONS : loaded.options;
  const optionsById = new Map(options.map((option) => [option.bankId, option]));

  /**
   * Where a bank goes when nobody has said.
   *
   * A bank whose archive says it came from a bank this profile still holds
   * starts on a replace of that bank, which is what "I sent this away, edited
   * it, and want it back" needs. The match is `bankId` against `bankId`; a
   * match on the *name* would land on whichever bank called "SFX" came first
   * and quietly delete it.
   */
  const defaultPlacement = (bank: BankSummary): BankPlacement =>
    optionsById.has(bank.sourceBankId)
      ? { kind: "replace", bankId: bank.sourceBankId }
      : { kind: "add" };

  const placementOf = (bank: BankSummary): BankPlacement =>
    chosen[bank.folder] ?? defaultPlacement(bank);

  const placements: Record<string, BankPlacement> = Object.fromEntries(
    banks.map((bank) => [bank.folder, placementOf(bank)]),
  );
  const chose = Object.values(placements);
  const addCount = chose.filter((placement) => placement.kind === "add").length;
  const writeCount = chose.filter(
    (placement) => placement.kind !== "skip",
  ).length;
  const freeSlots = Math.max(0, MAX_BANKS - options.length);

  // The first bank two rows are both aimed at, if there is one. The library
  // refuses the pair before it writes anything; naming it here is what lets
  // the user fix it rather than read a failure.
  const aimedAt = new Set<string>();
  let clash: BankListOption | undefined;
  for (const placement of chose) {
    if (placement.kind !== "replace") continue;
    if (aimedAt.has(placement.bankId)) {
      clash ??= optionsById.get(placement.bankId);
    }
    aimedAt.add(placement.bankId);
  }

  const problem =
    addCount > freeSlots
      ? `${profileName} holds ${options.length} of ${MAX_BANKS} banks, so there is room for ${freeSlots} more. ` +
        `${count(addCount, "bank here is", "banks here are")} set to be added — change at least ${addCount - freeSlots} of them to Replace or Skip.`
      : clash
        ? `Two of these banks are set to replace ${bankLabel(clash)}, and the second would ` +
          "overwrite the first. Choose a different bank, or Skip, for one of them."
        : null;

  const canImport =
    !isLoading && !isImporting && problem === null && writeCount > 0;

  /** What one row is about to do to the destination, in as many words. */
  const consequenceOf = (placement: BankPlacement): string => {
    if (placement.kind === "skip") return "Not imported.";
    if (placement.kind === "add") {
      return `Added as a new bank. Nothing already in ${profileName} changes.`;
    }
    const target = optionsById.get(placement.bankId);
    if (!target) return `That bank is no longer in ${profileName}.`;
    return target.soundCount === 0 && target.padCount === 0
      ? `${bankLabel(target)} is empty, so nothing is lost.`
      : `Deletes everything in ${bankLabel(target)} (${bankContents(target)}), and cannot be undone.`;
  };

  /**
   * Writes the banks, once the dialog is satisfied it can.
   *
   * The early return looks like a second copy of the button's `disabled`
   * attribute, and today it is unreachable: React does not dispatch a click
   * on a disabled button, so no test can get here with `canImport` false. It
   * stays anyway, because the thing on the other side of it is irreversible —
   * a `replace` clears a bank the user still has — and `disabled` is a
   * *rendering* decision that a form submit, an Enter key, a keyboard
   * shortcut or a differently rendered control would all walk straight past.
   * This repo's recorded characteristic failure is exactly that: a call site
   * adopting a shared helper without the guard that made the old call safe
   * (`EditPadModalContent`, Task 4b, which deleted audio another profile was
   * playing). A one-line early return in front of the dangerous operation is
   * the cheap half of that trade.
   */
  const handleImport = async () => {
    if (!canImport) return;
    setIsImporting(true);
    onBusyChange(true);
    setError(null);
    try {
      setResult(
        await importBanksFromArchive(
          archive.file,
          profileId,
          placements,
          setProgress,
        ),
      );
    } catch (caught) {
      console.error("Failed to import banks from the archive:", caught);
      setError(
        `The import could not finish: ${message(caught)} ` +
          `Nothing was imported, and ${profileName} is unchanged.`,
      );
    } finally {
      setIsImporting(false);
      onBusyChange(false);
      setProgress(null);
    }
  };

  const sourceName = banks[0]?.sourceProfileName ?? "another profile";

  return (
    <div
      data-testid="bank-import-dialog"
      className="mb-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10 p-4"
    >
      <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-1">
        Import {count(banks.length, "bank", "banks")} from &ldquo;{sourceName}
        &rdquo;
      </h4>
      <p
        data-testid="bank-import-target"
        className="text-sm text-gray-600 dark:text-gray-300 mb-2"
      >
        Into {profileName}, the profile you are using. Banks are always imported
        into the active profile; switch profiles first to import them somewhere
        else.
      </p>
      <p
        data-testid="bank-import-warning"
        className="text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/20 rounded p-3 mb-4"
      >
        Replacing a bank empties it first: its pads, its name and its emergency
        setting are all overwritten by the bank coming in, and there is no undo.
        These banks are imported all or nothing — if one of them cannot be
        written, none of them are, and {profileName} is left exactly as it is
        now.
      </p>

      {result ? (
        <div
          role="status"
          data-testid="bank-import-result"
          className="rounded p-3 mb-4 bg-green-50 dark:bg-green-900/20 text-sm text-green-800 dark:text-green-200"
        >
          <p>
            {result.written.length === 0
              ? `No banks were imported into ${profileName}.`
              : `Imported ${count(result.written.length, "bank", "banks")} into ${profileName}: ${nameList(
                  result.written.map((bank) => bank.name),
                )}.`}
          </p>
          {result.skipped.length > 0 && (
            <p className="mt-1">
              {count(result.skipped.length, "bank", "banks")} in the file{" "}
              {result.skipped.length === 1 ? "was" : "were"} skipped:{" "}
              {nameList(result.skipped)}.
            </p>
          )}
        </div>
      ) : isLoading ? (
        <p
          data-testid="bank-import-loading"
          className="text-sm text-gray-500 dark:text-gray-400 italic mb-4"
        >
          Reading {profileName}&rsquo;s banks…
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {banks.map((bank, index) => {
            const placement = placementOf(bank);
            return (
              <div
                key={bank.folder}
                data-testid="bank-import-row"
                data-folder={bank.folder}
                className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    data-testid="bank-import-name"
                    className="text-sm font-medium text-gray-900 dark:text-gray-100"
                  >
                    {index + 1}: {bankDisplayName(bank)}
                  </span>
                  <span
                    data-testid="bank-import-summary"
                    className="text-xs text-gray-500 dark:text-gray-400"
                  >
                    {bankContents({
                      padCount: bank.padCount,
                      soundCount: bank.audioCount,
                    })}
                    {bank.isEmergency ? " · Emergency bank" : ""}
                  </span>
                  <select
                    aria-label={`Where to put bank ${index + 1}: ${bankDisplayName(bank)}`}
                    data-testid={`bank-placement-${bank.folder}`}
                    value={placementValue(placement)}
                    disabled={isImporting}
                    onChange={(e) =>
                      setChosen((previous) => ({
                        ...previous,
                        [bank.folder]: placementFromValue(e.target.value),
                      }))
                    }
                    className="ml-auto rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
                  >
                    <option value="add">Add as a new bank</option>
                    {options.map((option) => (
                      <option
                        key={option.bankId}
                        value={`replace:${option.bankId}`}
                      >
                        Replace {bankLabel(option)}
                      </option>
                    ))}
                    <option value="skip">Skip this bank</option>
                  </select>
                </div>
                <p
                  data-testid="bank-import-consequence"
                  className={`mt-2 text-xs ${
                    placement.kind === "replace"
                      ? "text-red-700 dark:text-red-300"
                      : "text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {consequenceOf(placement)}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {problem && !result && (
        <p
          role="alert"
          data-testid="bank-import-problem"
          className="mb-4 rounded p-3 text-sm bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
        >
          {problem}
        </p>
      )}

      {error && (
        <p
          role="alert"
          data-testid="bank-import-error"
          className="mb-4 rounded p-3 text-sm bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {result ? (
        <button
          type="button"
          data-testid="dismiss-bank-import"
          onClick={onDismiss}
          className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600"
        >
          Done
        </button>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="confirm-bank-import"
            onClick={handleImport}
            disabled={!canImport}
            className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
          >
            {isImporting
              ? "Importing…"
              : `Import ${count(writeCount, "Bank", "Banks")}`}
          </button>
          <button
            type="button"
            data-testid="cancel-bank-import"
            onClick={onDismiss}
            disabled={isImporting}
            className="px-4 py-2 rounded-md bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:cursor-not-allowed"
          >
            Cancel import
          </button>
        </div>
      )}

      {isImporting && progress && (
        <TransferProgressBar progress={progress} verb="Importing" />
      )}
    </div>
  );
}
