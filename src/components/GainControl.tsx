"use client";

import { MANUAL_GAIN_RANGE_DB } from "@/lib/audio/loudness/constants";
import { formatGainDb, gainToneClass } from "@/lib/audio/loudness/format";

interface GainControlProps {
  valueDb: number;
  onChange: (db: number) => void;
  /**
   * Fires once the user has finished adjusting — pointer release or the
   * control losing focus (so a keyboard-driven change commits too) — rather
   * than on every intermediate `onChange` tick during a drag. Optional and
   * additive: a caller that only needs the live value (e.g. `EditPadForm`,
   * which just buffers into its own form state and saves once on submit)
   * can omit it and nothing changes.
   *
   * A caller that writes on every `onChange` (e.g. the loudness overview,
   * which persists straight to IndexedDB) should instead buffer locally on
   * `onChange` and do the actual write from `onCommit` — otherwise a single
   * drag fires one write per tick instead of one write for the gesture.
   */
  onCommit?: (db: number) => void;
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
  onCommit,
  label,
  testId,
  compact = false,
}: GainControlProps) {
  // Read the value straight off the DOM at commit time rather than closing
  // over `valueDb`: the prop only reflects the caller's state after it has
  // re-rendered from the preceding `onChange`, and there is no guarantee
  // that has happened yet by the time the pointer-up/blur handler runs.
  // The input's own value is authoritative regardless of that timing.
  const commitFromEvent = (e: { currentTarget: HTMLInputElement }) =>
    onCommit?.(Number(e.currentTarget.value));

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
          onPointerUp={commitFromEvent}
          onBlur={commitFromEvent}
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
          // Without this, clicking Reset while the slider has focus first
          // shifts focus to this button — blurring the slider and firing
          // GainControl's own onBlur commit with the pre-reset value — and
          // then this handler's onCommit?.(0) fires a second, unordered
          // write against the same record. Whichever of the two lands last
          // in IndexedDB silently wins, so Reset could visibly fail to
          // reset. preventDefault on mousedown stops the focus shift (the
          // click still fires normally), so the slider never blurs and this
          // is the only commit.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange(0);
            onCommit?.(0);
          }}
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
