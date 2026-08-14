/**
 * Audio Module - Loudness overview rows
 *
 * Builds the rows behind the loudness overview table. Every level comes from
 * resolveGain — the same function the playback path calls — so the table can
 * never disagree with what is actually heard.
 *
 * @module lib/audio/loudness/overview
 */

import type { PadConfiguration } from "@/lib/db";
import { resolveGain } from "./gain";
import type {
  LoudnessAnalysis,
  NormalisationSettings,
  ResolvedGain,
} from "./types";

/** How far off target a row must be to count as a problem, dB. */
const PROBLEM_DEVIATION_DB = 3;

export interface SoundRow {
  key: string;
  pageIndex: number;
  padIndex: number;
  bankName: string;
  padName: string;
  audioFileId: number;
  soundName: string;
  gain: ResolvedGain;
  soundGainDb: number;
  padGainDb: number;
}

export interface PadRow {
  key: string;
  pageIndex: number;
  padIndex: number;
  bankName: string;
  padName: string;
  soundCount: number;
  minLufs: number | null;
  maxLufs: number | null;
  /** max - min across the pad's measurable sounds. null when none are. */
  spreadDb: number | null;
}

export interface BuildRowsOptions {
  normalisation: NormalisationSettings;
  getAnalysis: (audioFileId: number) => LoudnessAnalysis | undefined;
  getSoundName: (audioFileId: number) => string;
  getBankName: (pageIndex: number) => string;
}

export function buildSoundRows(
  pads: PadConfiguration[],
  options: BuildRowsOptions,
): SoundRow[] {
  const rows: SoundRow[] = [];

  for (const pad of pads) {
    for (const audioFileId of pad.audioFileIds ?? []) {
      const trim = pad.audioTrimSettings?.[audioFileId];
      const soundGainDb = pad.audioGainSettings?.[audioFileId] ?? 0;
      const padGainDb = pad.padGainDb ?? 0;

      rows.push({
        key: `${pad.pageIndex}-${pad.padIndex}-${audioFileId}`,
        pageIndex: pad.pageIndex,
        padIndex: pad.padIndex,
        bankName: options.getBankName(pad.pageIndex),
        padName: pad.name ?? `Pad ${pad.padIndex + 1}`,
        audioFileId,
        soundName: options.getSoundName(audioFileId),
        gain: resolveGain({
          analysis: options.getAnalysis(audioFileId),
          trimStart: trim?.trimStart ?? 0,
          trimEnd: trim?.trimEnd,
          soundGainDb,
          padGainDb,
          normalisation: options.normalisation,
        }),
        soundGainDb,
        padGainDb,
      });
    }
  }

  return rows;
}

export function buildPadRows(soundRows: SoundRow[]): PadRow[] {
  const byPad = new Map<string, SoundRow[]>();

  for (const row of soundRows) {
    const key = `${row.pageIndex}-${row.padIndex}`;
    const existing = byPad.get(key);
    if (existing) existing.push(row);
    else byPad.set(key, [row]);
  }

  const padRows: PadRow[] = [];

  for (const [key, rows] of byPad) {
    const levels = rows
      .map((r) => r.gain.finalLufs)
      .filter((v): v is number => v !== null);

    padRows.push({
      key,
      pageIndex: rows[0].pageIndex,
      padIndex: rows[0].padIndex,
      bankName: rows[0].bankName,
      padName: rows[0].padName,
      soundCount: rows.length,
      minLufs: levels.length ? Math.min(...levels) : null,
      maxLufs: levels.length ? Math.max(...levels) : null,
      spreadDb: levels.length
        ? Math.max(...levels) - Math.min(...levels)
        : null,
    });
  }

  return padRows;
}

export type SoundSortKey =
  | "bank"
  | "soundName"
  | "measured"
  | "norm"
  | "soundGain"
  | "padGain"
  | "final"
  | "deviation";

export type SortDirection = "asc" | "desc";

function sortValue(
  row: SoundRow,
  key: SoundSortKey,
  target: number,
): number | string | null {
  switch (key) {
    case "bank":
      return row.pageIndex * 1000 + row.padIndex;
    case "soundName":
      return row.soundName.toLowerCase();
    case "measured":
      return row.gain.measuredLufs;
    case "norm":
      return row.gain.normDb;
    case "soundGain":
      return row.soundGainDb;
    case "padGain":
      return row.padGainDb;
    case "final":
      return row.gain.finalLufs;
    case "deviation":
      return row.gain.finalLufs === null
        ? null
        : Math.abs(row.gain.finalLufs - target);
  }
}

/**
 * Sorts rows, always pushing unmeasurable rows to the end.
 *
 * Without that, a row with no measurement would sort as if it were zero and
 * appear among the worst offenders, which is misleading.
 */
export function sortRows(
  rows: SoundRow[],
  key: SoundSortKey,
  direction: SortDirection,
  target: number,
): SoundRow[] {
  const factor = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const av = sortValue(a, key, target);
    const bv = sortValue(b, key, target);

    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;

    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * factor;
    }
    return ((av as number) - (bv as number)) * factor;
  });
}

/**
 * Keeps only rows worth acting on: clipping, peak-limited, or well off target.
 * Rows that are merely not analysed yet are not problems.
 */
export function filterProblemRows(
  rows: SoundRow[],
  target: number,
): SoundRow[] {
  return rows.filter((row) => {
    if (row.gain.unmeasured) return false;
    if (row.gain.willClip || row.gain.peakLimited || row.gain.gainClamped) {
      return true;
    }
    if (row.gain.finalLufs === null) return false;
    return Math.abs(row.gain.finalLufs - target) > PROBLEM_DEVIATION_DB;
  });
}
