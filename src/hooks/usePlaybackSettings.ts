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
import type { Profile } from "@/lib/db";
import type { PlaybackSettingsFormValues, FormErrors } from "@/types/forms";

// Extended profile interface for runtime properties that might not be in the DB schema
interface ExtendedProfile extends Profile {
  fadeoutDuration?: number;
}

/**
 * Hook that provides functionality to open and manage playback settings form
 */
export function usePlaybackSettings() {
  const { openFormModal } = useFormModal();
  const { profiles, activeProfileId, updateProfile } = useProfileStore();

  /**
   * Opens a modal for editing playback settings
   */
  const openPlaybackSettings = () => {
    if (!activeProfileId) {
      console.error("Cannot edit playback settings: no active profile");
      return;
    }

    // Get the active profile from the profiles array
    const activeProfile = profiles.find(
      (p) => p.id === activeProfileId,
    ) as ExtendedProfile;
    if (!activeProfile) {
      console.error("Cannot edit playback settings: active profile not found");
      return;
    }

    // Default values
    const DEFAULT_FADEOUT_DURATION = 3.0;

    // Set up initial values with defaults for missing properties
    const initialValues: PlaybackSettingsFormValues = {
      fadeoutDuration:
        activeProfile.fadeoutDuration ?? DEFAULT_FADEOUT_DURATION,
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
          // First, update the standard profile properties
          await updateProfile(activeProfile.id!, {
            activePadBehavior: values.activePadBehavior,
          });

          // Then update the fadeoutDuration property
          // We need to cast to unknown first since fadeoutDuration isn't in the standard Profile interface
          await updateProfile(activeProfile.id!, {
            fadeoutDuration: values.fadeoutDuration,
          } as unknown as Partial<ExtendedProfile>);

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
