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
  getAudioFile,
  upsertPadConfiguration,
  type PadConfiguration,
} from "@/lib/db";
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

  const [pads, setPads] = useState<PadConfiguration[]>([]);
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [tab, setTab] = useState<"sounds" | "pads">("sounds");
  const [sortKey, setSortKey] = useState<SoundSortKey>("deviation");
  const [direction, setDirection] = useState<SortDirection>("desc");
  const [problemsOnly, setProblemsOnly] = useState(false);
  // "all" or a pageIndex. Independent of tab/sort/gain-edit state so it
  // survives all three — nothing here ever resets it.
  const [bankFilter, setBankFilter] = useState<number | "all">("all");
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

  // Load this profile's pads and every distinct sound name they reference.
  useEffect(() => {
    if (activeProfileId === null) return;
    let cancelled = false;

    void (async () => {
      const loaded = await getAllPadConfigurationsForProfile(activeProfileId);
      if (cancelled) return;
      setPads(loaded);

      // A full board can have hundreds of pad-sound slots but far fewer
      // distinct audio files (the same sound reused across many pads).
      // Dedupe the ids first, then fetch the survivors concurrently — one
      // round-trip per distinct file, all in flight at once, instead of one
      // sequential round-trip per pad-sound slot.
      const uniqueIds = [
        ...new Set(loaded.flatMap((pad) => pad.audioFileIds ?? [])),
      ];
      const entries = await Promise.all(
        uniqueIds.map(async (id): Promise<[number, string]> => {
          const file = await getAudioFile(id);
          return [id, file?.name ?? `Sound ${id}`];
        }),
      );
      if (!cancelled) setNames(new Map(entries));
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
  // itself. runBackfill's generation-token supersede logic assumes exactly
  // one caller (ClientSideInitializer) — a second caller here would take a
  // fresh token, supersede that run, and could leave the in-memory loudness
  // cache repopulated from a pre-analysis snapshot. Same pattern as
  // ProfileCard's backfill indicator.
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
        getBankName: (pageIndex) => `Bank ${pageIndex + 1}`,
      }),
    // cacheVersion is intentionally unread: getCachedLoudness reads a module
    // -level cache the linter can't see into, so bumping this counter is the
    // only way to tell the memo that a background-analysed sound needs
    // recomputing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pads, normalisation, names, cacheVersion],
  );

  // Distinct banks that actually hold a sound, in bank order — not all
  // twenty pages, which would make the filter useless on a mostly-empty
  // board.
  const bankOptions = useMemo(() => {
    const byPageIndex = new Map<number, string>();
    for (const row of soundRows) {
      if (!byPageIndex.has(row.pageIndex)) {
        byPageIndex.set(row.pageIndex, row.bankName);
      }
    }
    return [...byPageIndex.entries()].sort(([a], [b]) => a - b);
  }, [soundRows]);

  // Bank and "problems only" compose: both active means rows matching both.
  const bankFilteredRows = useMemo(
    () =>
      bankFilter === "all"
        ? soundRows
        : soundRows.filter((row) => row.pageIndex === bankFilter),
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
    pageIndex: number,
    padIndex: number,
    audioFileId: number,
    db: number,
  ) => {
    const pad = pads.find(
      (p) => p.pageIndex === pageIndex && p.padIndex === padIndex,
    );
    if (!pad || activeProfileId === null) {
      console.warn(
        `[LoudnessOverview] No pad found at ${pageIndex}-${padIndex} for sound ${audioFileId}; discarding gain edit.`,
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
        pageIndex: pad.pageIndex,
        padIndex: pad.padIndex,
        keyBinding: pad.keyBinding,
        name: pad.name,
        audioFileIds: pad.audioFileIds,
        audioTrimSettings: pad.audioTrimSettings,
        audioGainSettings: updatedGainSettings,
        padGainDb: pad.padGainDb,
        playbackType: pad.playbackType,
        isDisabled: pad.isDisabled,
      });

      setPads((current) =>
        current.map((p) =>
          p.pageIndex === pageIndex && p.padIndex === padIndex
            ? { ...p, audioGainSettings: updatedGainSettings }
            : p,
        ),
      );
    } catch (error) {
      // The slider is a controlled input driven by `pendingGain` while a
      // drag is in flight; since `pads` never updated, clearing the buffer
      // below is what makes it visibly snap back to the last-saved value
      // instead of silently disagreeing with both React state and the
      // database.
      console.warn(
        `[LoudnessOverview] Failed to save gain for pad ${pageIndex}-${padIndex}, sound ${audioFileId}:`,
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
              value={bankFilter === "all" ? "all" : String(bankFilter)}
              onChange={(e) =>
                setBankFilter(
                  e.target.value === "all" ? "all" : Number(e.target.value),
                )
              }
              aria-label="Filter to one bank"
              data-testid="loudness-bank-filter"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
            >
              <option value="all">All banks</option>
              {bankOptions.map(([pageIndex, bankName]) => (
                <option key={pageIndex} value={pageIndex}>
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
                          row.pageIndex,
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

      {visibleRows.length === 0 && tab === "sounds" && (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {problemsOnly
            ? "No problems found — every sound is within 3 dB of target."
            : "No sounds assigned yet."}
        </p>
      )}
    </div>
  );
}
