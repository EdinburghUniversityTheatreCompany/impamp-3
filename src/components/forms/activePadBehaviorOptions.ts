/**
 * Radio options for "what happens when a pad is triggered while it plays".
 *
 * Three forms offer this choice — Playback Settings, the profile editor and
 * the pad editor — and before this module each of them wrote the option list
 * out again. That is the same shape as the `ActivePadBehavior` union itself,
 * which lived in four copies until one of them fell behind: adding "layer" to
 * two lists and missing the third is invisible to the compiler, and the
 * symptom is a behaviour a user can select in one place and not another.
 *
 * @module components/forms/activePadBehaviorOptions
 */

import { MAX_LAYERS_PER_PAD } from "@/lib/audio/types";
import type { ActivePadBehavior } from "@/lib/db";

/** One entry of a `RadioGroup`'s `options`, narrowed to this choice. */
export interface ActivePadBehaviorOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

/**
 * The pad editor's "follow the profile" value.
 *
 * A radio group always has a value, so "no override" needs one too. The pad
 * form maps it back to `undefined` on the way out, because `undefined` is what
 * `resolveActivePadBehavior` reads as "ask the profile" — storing the
 * profile's current answer instead would freeze it at the moment the pad was
 * last saved.
 */
export const FOLLOW_PROFILE = "" as const;

/** The four behaviours, in one-in-one-out order with layering last. */
export const activePadBehaviorOptions: ActivePadBehaviorOption<ActivePadBehavior>[] =
  [
    {
      value: "continue",
      label: "Continue Playing",
      description: "The sound will continue playing uninterrupted.",
    },
    {
      value: "stop",
      label: "Stop Sound",
      description: "The sound will stop immediately.",
    },
    {
      value: "restart",
      label: "Restart Sound",
      description: "The sound will restart from the beginning.",
    },
    {
      value: "layer",
      label: "Layer Sounds",
      // The cap comes from the constant the engine enforces, so the two cannot
      // drift into telling the user a different number from the one that bites.
      description:
        `Each trigger starts another copy on top of the ones already ` +
        `playing, up to ${MAX_LAYERS_PER_PAD} at once. After that, a new ` +
        `trigger stops the oldest copy.`,
    },
  ];

/** The same four, behind the pad editor's "no override of my own" option. */
export const padActivePadBehaviorOptions: ActivePadBehaviorOption<
  ActivePadBehavior | typeof FOLLOW_PROFILE
>[] = [
  {
    value: FOLLOW_PROFILE,
    label: "Use profile default",
    description: "This pad does whatever the profile's playback settings say.",
  },
  ...activePadBehaviorOptions,
];
