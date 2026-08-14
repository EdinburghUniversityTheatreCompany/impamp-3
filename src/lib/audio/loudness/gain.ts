/**
 * Audio Module - Gain resolution
 *
 * The single source of truth for level arithmetic. Both the playback path and
 * the loudness overview call this; a second implementation anywhere would let
 * the table disagree with what you hear, which is worse than having no table.
 *
 * Every reported figure derives from `totalDb` — the gain actually applied
 * after the rails — never from the gain that was requested.
 *
 * @module lib/audio/loudness/gain
 */

import { clampTrimRange } from "../playback";
import {
  MAX_NORM_BOOST_DB,
  MAX_TOTAL_GAIN_DB,
  PEAK_CEILING_DBTP,
} from "./constants";
import { measureRange } from "./query";
import type { ResolvedGain, ResolveGainInput } from "./types";

export function resolveGain(input: ResolveGainInput): ResolvedGain {
  const { analysis, soundGainDb, padGainDb, normalisation } = input;

  const manualDb = soundGainDb + padGainDb;

  if (!analysis) {
    const totalDb = Math.min(manualDb, MAX_TOTAL_GAIN_DB);
    return {
      normDb: 0,
      totalDb,
      linear: 10 ** (totalDb / 20),
      measuredLufs: null,
      finalLufs: null,
      truePeakDb: -Infinity,
      predictedPeakDb: -Infinity,
      peakLimited: false,
      boostCapped: false,
      gainClamped: manualDb > MAX_TOTAL_GAIN_DB,
      willClip: false,
      estimated: false,
      unmeasured: true,
    };
  }

  // Route through the same clamping playback uses: a stored trim range can
  // be malformed (non-finite, reversed, or past the real duration), and
  // playback's answer to that — discard it and use the whole file — is the
  // one this measurement must agree with. Without this, a `{0, 0}` "no trim"
  // pad measures a zero-width range, finds no blocks, and plays completely
  // un-normalised while the overview shows "—" for a pad that audibly plays.
  const clampedRange = clampTrimRange(
    input.trimStart,
    input.trimEnd,
    analysis.duration,
  );
  const range = measureRange(
    analysis,
    clampedRange.trimStart,
    clampedRange.trimEnd ?? analysis.duration,
  );

  const canNormalise = normalisation.enabled && range.lufs !== null;
  const rawNormDb = canNormalise
    ? normalisation.targetLufs - (range.lufs as number)
    : 0;

  const peakHeadroomDb = PEAK_CEILING_DBTP - range.truePeakDb;
  const normDb = canNormalise
    ? Math.min(rawNormDb, peakHeadroomDb, MAX_NORM_BOOST_DB)
    : 0;

  const rawTotalDb = normDb + manualDb;
  const totalDb = Math.min(rawTotalDb, MAX_TOTAL_GAIN_DB);

  const predictedPeakDb = range.truePeakDb + totalDb;

  return {
    normDb,
    totalDb,
    linear: 10 ** (totalDb / 20),
    measuredLufs: range.lufs,
    finalLufs: range.lufs === null ? null : range.lufs + totalDb,
    truePeakDb: range.truePeakDb,
    predictedPeakDb,
    peakLimited: canNormalise && rawNormDb > peakHeadroomDb,
    boostCapped: canNormalise && rawNormDb > MAX_NORM_BOOST_DB,
    gainClamped: rawTotalDb > MAX_TOTAL_GAIN_DB,
    willClip: predictedPeakDb > 0,
    estimated: range.estimated,
    unmeasured: false,
  };
}
