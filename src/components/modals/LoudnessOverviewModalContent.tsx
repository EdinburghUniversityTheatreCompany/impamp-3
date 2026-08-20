/**
 * Loudness overview modal
 *
 * A sortable table of every sound on the active profile, worst-first by
 * default, answering "which of these is wrong?" rather than merely listing
 * sounds. Every level shown comes from `resolveGain` — via `buildSoundRows`
 * — so this table can never disagree with what actually plays.
 *
 * @module components/modals/LoudnessOverviewModalContent
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import GainControl from "@/components/GainControl";
import {
  getCachedLoudness,
  subscribeToLoudnessCache,
} from "@/lib/audio/loudness/cache";
import {
  formatDbMagnitude,
  formatGainDb,
  formatLufs,
  gainToneClass,
} from "@/lib/audio/loudness/format";
import {
  buildPadRows,
  buildSoundRows,
  filterProblemRows,
  sortRows,
  type SortDirection,
  type SoundSortKey,
} from "@/lib/audio/loudness/overview";
import { DEFAULT_NORMALISATION } from "@/lib/audio/loudness/types";
import {
  getAllPageMetadataForProfile,
  getAudioFileMetadata,
  upsertPadConfiguration,
  type PadConfiguration,
} from "@/lib/db";
import { convertIndexToBankNumber } from "@/lib/bankUtils";
import { getAllPadConfigurationsForProfile } from "@/lib/importExport";
import { useProfileStore } from "@/store/profileStore";

const COLUMNS: { key: SoundSortKey; label: string }[] = [
  { key: "bank", label: "Bank · Pad" },
  { key: "soundName", label: "Sound" },
  { key: "measured", label: "Measured" },
  { key: "norm", label: "Norm" },
  { key: "soundGain", label: "Sound gain" },
  { key: "padGain", label: "Pad gain" },
  { key: "final", label: "Final" },
  { key: "deviation", label: "Δ target" },
];

export default function LoudnessOverviewModalContent() {
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const normalisation = useProfileStore(
    (s) =>
      s.profiles.find((p) => p.id === s.activeProfileId)?.normalisation ??
      DEFAULT_NORMALISATION,
  );
  const incrementPadConfigsVersion = useProfileStore(
    (s) => s.incrementPadConfigsVersion,
  );
  const requestSync = useProfileStore((s) => s.requestSync);

  const [pads, setPads] = useState<PadConfiguration[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  // bankId -> the bank's display name (its own name, or the synthesised
  // "Bank N" fallback), for every bank on the profile.
  const [bankNames, setBankNames] = useState<Map<string, string>>(new Map());
  // bankId -> its display position, kept only so the bank filter dropdown
  // can be sorted in tab order rather than by bankId.
  const [bankPositions, setBankPositions] = useState<Map<string, number>>(
    new Map(),
  );
  const [tab, setTab] = useState<"sounds" | "pads">("sounds");
  const [sortKey, setSortKey] = useState<SoundSortKey>("deviation");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [problemsOnly, setProblemsOnly] = useState(false);
  // "all" or a bankId. Independent of tab/sort/gain-edit state so it
  // survives all three — nothing here ever resets it.
  const [bankFilter, setBankFilter] = useState<string | "all">("all");
  // Bumped whenever the loudness cache changes; not read directly, only
  // used as a memo dependency below to force `soundRows` to recompute once
  // an unmeasured sound gets measured by the background sweep.
  const [cacheVersion, setCacheVersion] = useState(0);
  // Buffers a sound-gain drag in progress: GainControl's <input type="range">
  // fires onChange continuously while dragging, not on release, so writing
  // straight to the database on every tick would amplify one drag into
  // dozens of IndexedDB writes and — worse — resort the (worst-first) table
  // out from under the pointer mid-gesture. Holding the live value here
  // instead means `pads` (and therefore the sort) only changes once, when
  // the drag actually ends.
  const [pendingGain, setPendingGain] = useState<{
    key: string;
    db: number;
  } | null>(null);
  // True until the initial pad/name load resolves, so the "No sounds
  // assigned yet" empty state doesn't flash for a frame on every open before
  // any pads have been fetched.
  const [isLoading, setIsLoading] = useState(true);

  // Load this profile's pads and every distinct sound name they reference.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (activeProfileId === null) {
        // No profile to load pads for — without this, isLoading would stay
        // true forever and the "No sounds assigned yet" empty state would
        // never get a chance to render.
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        // Bank names come from the same place the tabs read them, so this
        // table calls a bank what the tab above it calls it — it used to say
        // "Bank 3" while the tab said "3: Act 1 SFX".
        //
        // Fetched alongside the pads rather than after them: both feed the
        // same memo, and setting them a render apart would paint the table
        // once with the numbers and again with the names.
        const [loaded, pages] = await Promise.all([
          getAllPadConfigurationsForProfile(activeProfileId),
          getAllPageMetadataForProfile(activeProfileId),
        ]);
        if (cancelled) return;
        setPads(loaded);
        setBankNames(
          new Map(
            pages.map((page) => [
              page.bankId,
              page.name || `Bank ${convertIndexToBankNumber(page.pageIndex)}`,
            ]),
          ),
        );
        setBankPositions(
          new Map(pages.map((page) => [page.bankId, page.pageIndex])),
        );

        // A full board can have hundreds of pad-sound slots but far fewer
        // distinct audio files (the same sound reused across many pads).
        // Dedupe the ids first, then fetch the survivors concurrently — one
        // round-trip per distinct file, all in flight at once, instead of one
        // sequential round-trip per pad-sound slot.
        const uniqueIds = [
          ...new Set(loaded.flatMap((pad) => pad.audioFileIds ?? [])),
        ];
        // Deduping was right; firing the survivors off concurrently was not.
        // Each `getAudioFile` reads the *whole* record, Blob included, to take
        // a name — so a full board put up to 960 audio files in memory at once
        // to populate a table of strings. One cursor pass reads the names and
        // leaves the bytes on disk.
        const metadata = await getAudioFileMetadata(uniqueIds);
        const entries: [number, string][] = uniqueIds.map((id) => [
          id,
          metadata.get(id)?.name ?? `Sound ${id}`,
        ]);
        if (!cancelled) {
          setNames(new Map(entries));
        }
      } catch (error) {
        // A rejection here (a bad pad, a missing audio file, IndexedDB
        // hiccupping) must not leave the table stuck on its loading state —
        // that would render as a permanently blank modal with no message,
        // worse than not having a loading flag at all.
        console.error(
          "[LoudnessOverview] Failed to load pad configurations:",
          error,
        );
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  // A file can be unanalysed when this table opens and measured moments
  // later by the idle background sweep. Subscribe so a row that was showing
  // "unmeasured" picks up the real number without the user reopening.
  useEffect(() => {
    return subscribeToLoudnessCache(() => {
      setCacheVersion((v) => v + 1);
    });
  }, []);

  // Observes the background backfill's progress; never calls runBackfill
  // itself. `runBackfill` coalesces concurrent callers rather than one
  // superseding another, so it would in fact be safe to call from here too —
  // but this modal only wants to display progress, not decide when a
  // backfill should run, so it sticks to subscribeToBackfillProgress. Same
  // pattern as ProfileCard's backfill indicator.
  const [backfill, setBackfill] = useState({ done: 0, total: 0 });
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void import("@/lib/audio/loudness/pipeline")
      .then(({ subscribeToBackfillProgress }) => {
        if (cancelled) return;
        unsubscribe = subscribeToBackfillProgress(setBackfill);
      })
      .catch((error) => {
        console.warn(
          "[LoudnessOverview] Could not observe backfill progress:",
          error,
        );
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const soundRows = useMemo(
    () =>
      buildSoundRows(pads, {
        normalisation,
        getAnalysis: getCachedLoudness,
        getSoundName: (id) => names.get(id) ?? `Sound ${id}`,
        getBankName: (bankId) => bankNames.get(bankId) ?? `Bank ${bankId}`,
      }),
    // cacheVersion is intentionally unread: getCachedLoudness reads a module
    // -level cache the linter can't see into, so bumping this counter is the
    // only way to tell the memo that a background-analysed sound needs
    // recomputing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pads, normalisation, names, bankNames, cacheVersion],
  );

  // Distinct banks that actually hold a sound, in bank order — not all
  // twenty pages, which would make the filter useless on a mostly-empty
  // board.
  const bankOptions = useMemo(() => {
    const byBankId = new Map<string, string>();
    for (const row of soundRows) {
      if (!byBankId.has(row.bankId)) {
        byBankId.set(row.bankId, row.bankName);
      }
    }
    return [...byBankId.entries()].sort(
      ([a], [b]) => (bankPositions.get(a) ?? 0) - (bankPositions.get(b) ?? 0),
    );
  }, [soundRows, bankPositions]);

  // Bank and "problems only" compose: both active means rows matching both.
  const bankFilteredRows = useMemo(
    () =>
      bankFilter === "all"
        ? soundRows
        : soundRows.filter((row) => row.bankId === bankFilter),
    [soundRows, bankFilter],
  );

  const visibleRows = useMemo(() => {
    const filtered = problemsOnly
      ? filterProblemRows(bankFilteredRows, normalisation.targetLufs)
      : bankFilteredRows;
    return sortRows(filtered, sortKey, direction, normalisation.targetLufs);
  }, [
    bankFilteredRows,
    problemsOnly,
    sortKey,
    direction,
    normalisation.targetLufs,
  ]);

  // The bank filter narrows both tabs; "problems only" narrows the sounds
  // tab alone, so the pads tab aggregates every sound on the (bank-scoped)
  // pad rather than only its problem ones.
  const padRows = useMemo(
    () => buildPadRows(bankFilteredRows),
    [bankFilteredRows],
  );

  const toggleSort = (key: SoundSortKey) => {
    if (key === sortKey) {
      setDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection("desc");
    }
  };

  // Called once, from GainControl's onCommit (pointer release / blur) — not
  // from onChange, which only updates the local `pendingGain` buffer above.
  // Takes the row's own key rather than reconstructing it, and only ever
  // clears `pendingGain` if it still holds that same key when this resolves
  // — a second row's drag (or a re-drag of this same row) may have started
  // while this write was in flight, and an older commit settling late must
  // not wipe a newer, still-live buffer out from under the user.
  const commitSoundGain = async (
    rowKey: string,
    bankId: string,
    padIndex: number,
    audioFileId: number,
    db: number,
  ) => {
    const pad = pads.find(
      (p) => p.bankId === bankId && p.padIndex === padIndex,
    );
    if (!pad || activeProfileId === null) {
      console.warn(
        `[LoudnessOverview] No pad found at ${bankId}-${padIndex} for sound ${audioFileId}; discarding gain edit.`,
      );
      setPendingGain((current) => (current?.key === rowKey ? null : current));
      return;
    }

    // Spread the pad's existing gain record — replacing it wholesale would
    // silently erase every other sound's gain on this pad, and that loss
    // would persist to the database, not just flicker on screen.
    const updatedGainSettings: Record<number, number> = {
      ...(pad.audioGainSettings ?? {}),
      [audioFileId]: db,
    };

    try {
      await upsertPadConfiguration({
        profileId: pad.profileId,
        bankId: pad.bankId,
        padIndex: pad.padIndex,
        keyBinding: pad.keyBinding,
        name: pad.name,
        audioFileIds: pad.audioFileIds,
        audioTrimSettings: pad.audioTrimSettings,
        audioGainSettings: updatedGainSettings,
        padGainDb: pad.padGainDb,
        playbackType: pad.playbackType,
        isDisabled: pad.isDisabled,
        // `activePadBehavior` is deliberately absent. This enumerates almost
        // the whole record, so it reads as an authoritative rewrite, but it is
        // a partial upsert: `upsertPadConfiguration` merges
        // `{...existing, ...padConfig}`, so an omitted key is preserved and an
        // explicitly-undefined one is erased. Nudging a gain must not erase a
        // pad's retrigger override. Do not "complete" this list.
      });

      setPads((current) =>
        current.map((p) =>
          p.bankId === bankId && p.padIndex === padIndex
            ? { ...p, audioGainSettings: updatedGainSettings }
            : p,
        ),
      );

      incrementPadConfigsVersion(); // Refresh keyboard bindings too
      requestSync(pad.profileId);
    } catch (error) {
      // The slider is a controlled input driven by `pendingGain` while a
      // drag is in flight; since `pads` never updated, clearing the buffer
      // below is what makes it visibly snap back to the last-saved value
      // instead of silently disagreeing with both React state and the
      // database.
      console.warn(
        `[LoudnessOverview] Failed to save gain for pad ${bankId}-${padIndex}, sound ${audioFileId}:`,
        error,
      );
    } finally {
      setPendingGain((current) => (current?.key === rowKey ? null : current));
    }
  };

  return (
    <div className="flex max-h-[70vh] flex-col" data-testid="loudness-overview">
      <div className="mb-3 flex items-center gap-4">
        <div className="flex gap-1" role="tablist">
          {(["sounds", "pads"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-sm capitalize ${
                tab === t
                  ? "bg-gray-200 font-medium dark:bg-gray-700"
                  : "text-gray-600 dark:text-gray-400"
              }`}
              data-testid={`loudness-tab-${t}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4">
          <label
            htmlFor="loudness-bank-filter"
            className="flex items-center gap-2 text-sm"
          >
            Bank
            <select
              id="loudness-bank-filter"
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value)}
              aria-label="Filter to one bank"
              data-testid="loudness-bank-filter"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="all">All banks</option>
              {bankOptions.map(([bankId, bankName]) => (
                <option key={bankId} value={bankId}>
                  {bankName}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={problemsOnly}
              onChange={(e) => setProblemsOnly(e.target.checked)}
              data-testid="loudness-problems-only"
            />
            Problems only
          </label>
        </div>
      </div>

      {backfill.total > 0 && backfill.done < backfill.total && (
        <p
          className="mb-2 text-xs text-gray-500 dark:text-gray-400"
          data-testid="loudness-backfill-progress"
        >
          Analysing sounds… {backfill.done} of {backfill.total}
        </p>
      )}

      <div className="overflow-auto">
        {tab === "sounds" ? (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr>
                {COLUMNS.map((col) => {
                  const isSorted = sortKey === col.key;
                  const sortStateLabel = isSorted
                    ? `, currently sorted ${
                        direction === "asc" ? "ascending" : "descending"
                      }`
                    : "";
                  return (
                    <th
                      key={col.key}
                      className="px-2 py-1"
                      aria-sort={
                        isSorted
                          ? direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 font-medium hover:underline"
                        aria-label={`Sort by ${col.label}${sortStateLabel}`}
                        data-testid={`loudness-sort-${col.key}`}
                      >
                        {col.label}
                        {isSorted && (
                          <span aria-hidden="true">
                            {direction === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-gray-100 dark:border-gray-700"
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    {row.bankName} · {row.padIndex + 1}
                  </td>
                  <td className="px-2 py-1">{row.soundName}</td>
                  <td
                    className="px-2 py-1 font-mono tabular-nums"
                    title={
                      row.untrimmedLufs !== null &&
                      row.untrimmedLufs !== row.gain.measuredLufs
                        ? `Untrimmed: ${formatLufs(row.untrimmedLufs)} LUFS`
                        : undefined
                    }
                  >
                    {formatLufs(row.gain.measuredLufs)}
                    {row.gain.estimated && (
                      <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                        est
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatGainDb(row.gain.normDb)}
                    {row.gain.peakLimited && (
                      <span
                        className="ml-1 inline-flex items-center gap-0.5 font-sans text-xs text-amber-700 dark:text-amber-300"
                        title="Normalisation was reduced to respect the peak ceiling"
                      >
                        <span aria-hidden="true">⚠</span>
                        peak-limited
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <GainControl
                      compact
                      valueDb={
                        pendingGain?.key === row.key
                          ? pendingGain.db
                          : row.soundGainDb
                      }
                      onChange={(db) => setPendingGain({ key: row.key, db })}
                      onCommit={(db) =>
                        void commitSoundGain(
                          row.key,
                          row.bankId,
                          row.padIndex,
                          row.audioFileId,
                          db,
                        )
                      }
                      label={`Sound gain for ${row.soundName} on ${row.bankName}, pad ${row.padIndex + 1}`}
                      testId={`loudness-sound-gain-${row.key}`}
                    />
                  </td>
                  <td
                    className={`px-2 py-1 font-mono tabular-nums ${gainToneClass(row.padGainDb)}`}
                  >
                    {formatGainDb(row.padGainDb)}
                  </td>
                  <td className="px-2 py-1 font-mono font-medium tabular-nums">
                    {formatLufs(row.gain.finalLufs)}
                  </td>
                  <td className="px-2 py-1">
                    {row.gain.willClip ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200">
                        ⚠ clips by {formatDbMagnitude(row.gain.predictedPeakDb)}{" "}
                        dB
                      </span>
                    ) : row.gain.gainClamped ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                        ⚠ gain clamped
                      </span>
                    ) : row.gain.unmeasured ? (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        analysing…
                      </span>
                    ) : row.gain.finalLufs === null ? (
                      <span className="text-gray-500 dark:text-gray-400">
                        —
                      </span>
                    ) : (
                      <span className="font-mono tabular-nums">
                        {formatGainDb(
                          row.gain.finalLufs - normalisation.targetLufs,
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white dark:bg-gray-800">
              <tr>
                <th className="px-2 py-1">Bank · Pad</th>
                <th className="px-2 py-1">Name</th>
                <th className="px-2 py-1">Sounds</th>
                <th className="px-2 py-1">Quietest</th>
                <th className="px-2 py-1">Loudest</th>
                <th className="px-2 py-1">Spread</th>
              </tr>
            </thead>
            <tbody>
              {padRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-t border-gray-100 dark:border-gray-700"
                >
                  <td className="px-2 py-1 whitespace-nowrap">
                    {row.bankName} · {row.padIndex + 1}
                  </td>
                  <td className="px-2 py-1">{row.padName}</td>
                  <td className="px-2 py-1 tabular-nums">{row.soundCount}</td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatLufs(row.minLufs)}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {formatLufs(row.maxLufs)}
                  </td>
                  <td className="px-2 py-1 font-mono tabular-nums">
                    {row.spreadDb === null ? "—" : formatGainDb(row.spreadDb)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!isLoading && visibleRows.length === 0 && tab === "sounds" && (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {problemsOnly
            ? "No problems found — every sound is within 3 dB of target."
            : "No sounds assigned yet."}
        </p>
      )}
    </div>
  );
}
