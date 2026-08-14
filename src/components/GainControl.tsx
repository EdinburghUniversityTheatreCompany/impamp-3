"use client";

import { MANUAL_GAIN_RANGE_DB } from "@/lib/audio/loudness/constants";
import { formatGainDb, gainToneClass } from "@/lib/audio/loudness/format";

interface GainControlProps {
  valueDb: number;
  onChange: (db: number) => void;
  label: string;
  testId?: string;
  compact?: boolean;
}

/**
 * A dB slider with a reset-to-unity affordance.
 *
 * The numeric value is always rendered beside the slider, so the colour
 * marking on it (see `gainToneClass`) is decoration and never the only
 * signal — a colour-blind user or a screen reader still gets the signed
 * dB value as text.
 */
export default function GainControl({
  valueDb,
  onChange,
  label,
  testId,
  compact = false,
}: GainControlProps) {
  return (
    <div className={compact ? "flex items-center gap-2" : "flex flex-col"}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={MANUAL_GAIN_RANGE_DB.min}
          max={MANUAL_GAIN_RANGE_DB.max}
          step={0.5}
          value={valueDb}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          className={compact ? "w-24" : "w-full"}
          data-testid={testId}
        />
        <span
          className={`w-12 text-right font-mono text-xs tabular-nums ${gainToneClass(valueDb)}`}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {formatGainDb(valueDb)}
        </span>
        <button
          type="button"
          onClick={() => onChange(0)}
          disabled={valueDb === 0}
          className="text-xs text-gray-500 underline disabled:opacity-40 dark:text-gray-400"
          aria-label={`Reset ${label} to 0 dB`}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
