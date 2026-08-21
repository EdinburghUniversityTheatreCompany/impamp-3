"use client";

/**
 * The Import / Export tab's "Export banks" panel.
 *
 * Choosing the banks is the whole of this UI, and it is the one place in the
 * bank-transfer feature where a person's idea of a bank ("the second SFX one")
 * has to become the identity every layer underneath works in. Everything below
 * takes `bankId`s; nothing below can tell that the wrong one was picked.
 *
 * Four things follow from that, and each is a test rather than a preference:
 *
 *  - **The list is in board order and numbered like the tabs.** It runs
 *    through `normaliseBankOrder`, the same function the tab strip and the
 *    digit keys use, so "3:" here and "3:" on the board are the same bank even
 *    after a reorder and even when a merge has left two banks on one
 *    `pageIndex`. Sorting by the raw `pageIndex` would agree on most profiles
 *    and disagree on exactly the ones a user has arranged by hand.
 *  - **Nothing is keyed on a name.** Bank names are user-supplied and are not
 *    unique — two banks called "SFX" is ordinary — so the row identity, the
 *    checkbox id and the `data-bank-id` all come from `bankId`, which the
 *    `profileBank` index makes unique inside a profile. The position prefix is
 *    what keeps the two labels apart on screen.
 *  - **The selection belongs to one profile.** A bank id means nothing in
 *    another profile, so changing the profile select empties the selection
 *    rather than carrying ids across.
 *  - **An empty bank is exportable.** A bank is a name, an emergency flag and
 *    an arrangement as much as it is a set of sounds; "replace that bank with
 *    my empty one" is a real thing to send, and refusing it here would be a
 *    rule the archive writer does not have. The panel says which banks are
 *    empty instead, so nobody exports a blank one by accident.
 */

import { useEffect, useState } from "react";
import {
  describeBank,
  loadBankOptions,
  UNNAMED_BANK,
  type BankListOption,
} from "@/lib/bankSummaries";
import { count } from "@/lib/plural";
import TransferProgressBar from "./TransferProgressBar";
import type { Profile } from "@/lib/db";
import type {
  TransferProgress,
  TransferProgressCallback,
} from "@/lib/importExport";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No banks ticked, as a shared value so it does not re-render on identity. */
const NOTHING_SELECTED: ReadonlySet<string> = new Set();

/** No rows: either nothing has been read yet, or the profile has no banks. */
const NO_OPTIONS: BankListOption[] = [];

export default function ExportBanksPanel({
  profiles,
  activeProfileId,
  exportBanksToZip,
}: {
  profiles: Profile[];
  activeProfileId: number | null;
  exportBanksToZip: (
    profileId: number,
    bankIds: string[],
    bankNames: string[],
    onProgress?: TransferProgressCallback,
  ) => Promise<boolean>;
}) {
  // The bank list follows a profile of its own rather than the active one: a
  // bank belongs to exactly one profile, and pulling one out of last season's
  // show is the reason to have this at all.
  const [chosenProfileId, setChosenProfileId] = useState<number | null>(
    activeProfileId,
  );
  // The rows, with the profile they were read for. A read takes a turn of the
  // event loop, and for that turn the previous profile's banks are still on
  // screen under the new profile's id — long enough to tick one and export a
  // bank the chosen profile does not contain. Pairing the two makes the stale
  // list unreachable rather than merely unlikely.
  const [loaded, setLoaded] = useState<{
    profileId: number | null;
    options: BankListOption[];
  }>({ profileId: null, options: NO_OPTIONS });
  // The selection carries the profile it was made in. A bank id means nothing
  // outside its own profile — and "0" is a *different* bank in every profile,
  // because that is the id `ensureDefaultBanks` gives the first one — so
  // owning the id here is what keeps a switch from silently ticking someone
  // else's bank. Derived rather than cleared, so there is no "remember to
  // clear it" at each of the several places the profile can change.
  const [selection, setSelection] = useState<{
    profileId: number | null;
    bankIds: ReadonlySet<string>;
  }>({ profileId: null, bankIds: NOTHING_SELECTED });
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A profile can be deleted while the manager is open, and the select would
  // then point at a row nothing holds — showing the browser's fallback option
  // while the panel still exported from the gone profile's id. Derived, so
  // there is no effect correcting state after the fact.
  const known = (id: number | null | undefined) =>
    id != null && profiles.some((profile) => profile.id === id);
  const sourceProfileId = known(chosenProfileId)
    ? chosenProfileId
    : known(activeProfileId)
      ? activeProfileId
      : (profiles[0]?.id ?? null);

  const selectedBankIds =
    selection.profileId === sourceProfileId
      ? selection.bankIds
      : NOTHING_SELECTED;

  const isLoading = loaded.profileId !== sourceProfileId;
  const options = isLoading ? NO_OPTIONS : loaded.options;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next =
        sourceProfileId === null
          ? NO_OPTIONS
          : await loadBankOptions(sourceProfileId);
      // A second switch while this read was in flight has already started its
      // own, and this answer describes a profile nobody is looking at.
      if (!cancelled) setLoaded({ profileId: sourceProfileId, options: next });
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceProfileId]);

  const setSelected = (bankIds: ReadonlySet<string>) =>
    setSelection({ profileId: sourceProfileId, bankIds });

  const toggle = (bankId: string, selected: boolean) => {
    const next = new Set(selectedBankIds);
    if (selected) next.add(bankId);
    else next.delete(bankId);
    setSelected(next);
  };

  // Board order, not the order they were ticked: the archive's bank order is
  // what the placement dialog lists at the far end, and "the order I happened
  // to click" is nobody's mental model of a set of banks.
  const selected = options.filter((option) =>
    selectedBankIds.has(option.bankId),
  );

  const handleExport = async () => {
    if (sourceProfileId === null || selected.length === 0) return;
    setIsExporting(true);
    setError(null);
    try {
      const saved = await exportBanksToZip(
        sourceProfileId,
        selected.map((option) => option.bankId),
        // The stored name, not the display fallback: this is what names the
        // file and what the far end reads, and "Unnamed bank" is a label.
        selected.map((option) => option.name),
        setProgress,
      );
      // `false` with no throw is the user closing the save dialog. Keeping
      // the selection is what lets them press the button again.
      if (saved) setSelected(NOTHING_SELECTED);
    } catch (caught) {
      console.error("Failed to export the selected banks:", caught);
      setError(
        `The export could not finish: ${message(caught)}. ` +
          "The banks are still selected, so you can try again.",
      );
    } finally {
      setIsExporting(false);
      setProgress(null);
    }
  };

  const nothingSelected = selected.length === 0;

  return (
    <section className="mb-8" data-testid="bank-export-section">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Export banks
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Export one or more banks to a single file, which you can import into
        another profile — on this computer or someone else&rsquo;s. A sound that
        several of the chosen banks use travels once. This is not a backup of
        the profile, and it does not count as one.
      </p>

      <label
        className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
        htmlFor="bank-export-profile"
      >
        Banks from
      </label>
      <select
        id="bank-export-profile"
        data-testid="bank-export-profile"
        value={sourceProfileId ?? ""}
        onChange={(e) => {
          setChosenProfileId(
            e.target.value === "" ? null : Number(e.target.value),
          );
          setError(null);
        }}
        className="mb-4 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
            {profile.id === activeProfileId ? " (Active)" : ""}
          </option>
        ))}
      </select>

      <div
        data-testid="bank-export-list"
        className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700 max-h-60 overflow-y-auto mb-3"
      >
        {isLoading ? (
          <p
            data-testid="bank-export-loading"
            className="text-sm text-gray-500 dark:text-gray-400 italic"
          >
            Reading this profile&rsquo;s banks…
          </p>
        ) : options.length === 0 ? (
          <p
            data-testid="bank-export-none"
            className="text-sm text-gray-500 dark:text-gray-400 italic"
          >
            This profile has no banks to export.
          </p>
        ) : (
          <div className="space-y-2">
            {options.map((option) => (
              <div
                key={option.bankId}
                data-testid="export-bank-option"
                data-bank-id={option.bankId}
                data-bank-position={option.position}
                className="flex items-start"
              >
                <input
                  id={`export-bank-${option.bankId}`}
                  data-testid="export-bank-checkbox"
                  type="checkbox"
                  checked={selectedBankIds.has(option.bankId)}
                  aria-describedby={`export-bank-summary-${option.bankId}`}
                  onChange={(e) => toggle(option.bankId, e.target.checked)}
                  className="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                />
                <div className="ml-2">
                  <label
                    htmlFor={`export-bank-${option.bankId}`}
                    data-testid="export-bank-label"
                    className="block text-sm text-gray-900 dark:text-gray-300"
                  >
                    {option.position + 1}:{" "}
                    {option.name.trim() ? (
                      option.name
                    ) : (
                      <span className="italic text-gray-500 dark:text-gray-400">
                        {UNNAMED_BANK}
                      </span>
                    )}
                  </label>
                  <span
                    id={`export-bank-summary-${option.bankId}`}
                    data-testid="export-bank-summary"
                    className="block text-xs text-gray-500 dark:text-gray-400"
                  >
                    {describeBank(option)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {options.length > 0 && (
        <div className="flex gap-3 mb-4 text-sm">
          <button
            type="button"
            data-testid="bank-export-select-all"
            onClick={() =>
              setSelected(new Set(options.map((option) => option.bankId)))
            }
            disabled={selected.length === options.length}
            className="text-blue-600 dark:text-blue-400 hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
          >
            Select all
          </button>
          <button
            type="button"
            data-testid="bank-export-clear"
            onClick={() => setSelected(NOTHING_SELECTED)}
            disabled={nothingSelected}
            className="text-blue-600 dark:text-blue-400 hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
          >
            Clear selection
          </button>
        </div>
      )}

      <button
        data-testid="export-selected-banks"
        onClick={handleExport}
        disabled={isExporting || nothingSelected}
        className={`px-4 py-2 ${
          nothingSelected
            ? "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
            : "bg-green-500 text-white hover:bg-green-600"
        } rounded-md transition-colors ${
          isExporting || nothingSelected ? "cursor-not-allowed" : ""
        }`}
      >
        {/*
         * Not "Export Selected", which is what the profile export above this
         * one is called: two buttons with one accessible name on one tab is
         * ambiguous to anybody reading the page rather than looking at it,
         * and Playwright's strict mode refused to click either.
         */}
        {isExporting
          ? "Exporting..."
          : `Export ${count(selected.length, "Bank", "Banks")}`}
      </button>

      {error && (
        <div
          role="alert"
          data-testid="bank-export-error"
          className="mt-3 rounded-lg p-4 bg-yellow-50 dark:bg-yellow-900/20 text-sm text-yellow-800 dark:text-yellow-200"
        >
          {error}
        </div>
      )}

      {isExporting && progress && (
        <TransferProgressBar progress={progress} verb="Exporting" />
      )}
    </section>
  );
}
