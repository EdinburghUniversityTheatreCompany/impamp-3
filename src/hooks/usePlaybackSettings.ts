/**
 * Playback Settings Hook
 *
 * Hook for opening and managing playback settings form
 *
 * @module hooks/usePlaybackSettings
 */

import React from "react";
import { useFormModal } from "@/hooks/modal/useFormModal";
import PlaybackSettingsForm from "@/components/settings/PlaybackSettingsForm";
import { useProfileStore } from "@/store/profileStore";
import type { PlaybackSettingsFormValues, FormErrors } from "@/types/forms";

/**
 * Hook that provides functionality to open and manage playback settings form
 */
export function usePlaybackSettings() {
  const { openFormModal } = useFormModal();
  const { profiles, activeProfileId, updateProfile } = useProfileStore();
  const fadeoutDuration = useProfileStore((state) => state.fadeoutDuration);
  const setFadeoutDuration = useProfileStore(
    (state) => state.setFadeoutDuration,
  );

  /**
   * Opens a modal for editing playback settings
   */
  const openPlaybackSettings = () => {
    if (!activeProfileId) {
      console.error("Cannot edit playback settings: no active profile");
      return;
    }

    // Get the active profile from the profiles array
    const activeProfile = profiles.find((p) => p.id === activeProfileId);
    if (!activeProfile) {
      console.error("Cannot edit playback settings: active profile not found");
      return;
    }

    // Default values
    const DEFAULT_FADEOUT_DURATION = 3.0;

    // Set up initial values with defaults for missing properties
    // The fadeout duration lives in the store, which is what every fade path reads
    const initialValues: PlaybackSettingsFormValues = {
      fadeoutDuration: fadeoutDuration ?? DEFAULT_FADEOUT_DURATION,
      activePadBehavior: activeProfile.activePadBehavior ?? "continue",
    };

    openFormModal<PlaybackSettingsFormValues>({
      title: "Playback Settings",
      initialValues,
      renderForm: (props) => React.createElement(PlaybackSettingsForm, props),
      validate: (values) => {
        const errors: FormErrors<PlaybackSettingsFormValues> = {};

        // Validate fadeout duration
        if (values.fadeoutDuration <= 0) {
          errors.fadeoutDuration = "Fadeout duration must be greater than 0";
        }

        return errors;
      },
      onSubmit: async (values) => {
        try {
          // Update the standard profile properties
          await updateProfile(activeProfile.id!, {
            activePadBehavior: values.activePadBehavior,
          });

          // The fadeout duration is a store setting (persisted by the store itself)
          setFadeoutDuration(values.fadeoutDuration);

          console.log("Playback settings updated successfully");
        } catch (error) {
          console.error("Failed to update playback settings:", error);
          throw error; // Re-throw to prevent modal from closing
        }
      },
      confirmText: "Save Settings",
      size: "md",
    });
  };

  return { openPlaybackSettings };
}
