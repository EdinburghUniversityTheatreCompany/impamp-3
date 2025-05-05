/**
 * Playback Settings Form Component
 *
 * Form for editing global playback settings
 *
 * @module components/settings/PlaybackSettingsForm
 */

import React from "react";
import { FormField, TextInput, RadioGroup } from "@/components/forms";
import type { PlaybackSettingsFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";

/**
 * Form component for editing playback settings
 */
const PlaybackSettingsForm: React.FC<
  FormModalRenderProps<PlaybackSettingsFormValues>
> = ({ values, updateValue, errors, isSubmitting }) => {
  return (
    <div className="space-y-4 relative">
      {isSubmitting && (
        <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      )}

      {/* Fadeout Duration */}
      <FormField
        id="fadeoutDuration"
        label="Fadeout Duration (seconds)"
        error={errors.fadeoutDuration as string}
      >
        <TextInput
          id="fadeoutDuration"
          type="number"
          value={values.fadeoutDuration.toString()}
          onChange={(value) =>
            updateValue("fadeoutDuration", parseFloat(value) || 0)
          }
          error={errors.fadeoutDuration as string}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          This duration is used when fading out tracks from the Active Tracks
          panel.
        </p>
      </FormField>

      {/* Active Pad Behavior */}
      <FormField
        id="activePadBehavior"
        label="Behavior when a pad is triggered while already playing:"
        error={errors.activePadBehavior as string}
      >
        <RadioGroup
          id="activePadBehavior"
          name="activePadBehavior"
          options={[
            {
              value: "continue",
              label: "Continue Playing",
              description: "The sound will continue playing uninterrupted.",
            },
            {
              value: "stop",
              label: "Stop Sound",
              description: "The current sound will stop immediately.",
            },
            {
              value: "restart",
              label: "Restart Sound",
              description: "The sound will restart from the beginning.",
            },
          ]}
          value={values.activePadBehavior}
          onChange={(value) =>
            updateValue(
              "activePadBehavior",
              value as "continue" | "stop" | "restart",
            )
          }
          error={errors.activePadBehavior as string}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          This setting will be used for the current profile.
        </p>
      </FormField>
    </div>
  );
};

export default PlaybackSettingsForm;
