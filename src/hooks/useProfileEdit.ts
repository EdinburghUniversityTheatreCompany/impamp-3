/**
 * Profile Edit Hook
 *
 * Hook for opening and managing profile edit forms
 *
 * @module hooks/useProfileEdit
 */

import React from "react";
import { useFormModal } from "@/hooks/modal/useFormModal";
import ProfileEditForm from "@/components/profiles/ProfileEditForm";
import { useProfileStore } from "@/store/profileStore";
import type { ProfileFormValues, FormErrors } from "@/types/forms";
import type { Profile } from "@/lib/db";
import { DEFAULT_BACKUP_REMINDER_PERIOD_MS } from "@/lib/db";

/**
 * Hook that provides functionality to open and manage profile edit forms
 */
export function useProfileEdit() {
  const { openFormModal } = useFormModal();
  // Per-field: a bare `useProfileStore()` re-renders on every mutation of
  // the store, and this store carries the bank index, edit mode, the sync
  // request queue and every token refresh.
  const updateProfile = useProfileStore((s) => s.updateProfile);

  /**
   * Opens a modal for editing a profile
   * @param profile The profile to edit
   */
  const openProfileEditor = (profile: Profile) => {
    if (!profile.id) {
      console.error("Cannot edit profile: no ID provided");
      return;
    }

    // Set up initial values with defaults for missing properties. The
    // fallback is the database's own default rather than a second `30 *
    // MS_IN_DAY` written here, which is what it used to be.
    const initialValues: ProfileFormValues = {
      name: profile.name,
      backupReminderPeriod:
        profile.backupReminderPeriod ?? DEFAULT_BACKUP_REMINDER_PERIOD_MS,
      activePadBehavior: profile.activePadBehavior ?? "continue",
    };

    openFormModal<ProfileFormValues>({
      title: `Edit Profile: ${profile.name}`,
      initialValues,
      renderForm: (props) => React.createElement(ProfileEditForm, props),
      validate: (values) => {
        const errors: FormErrors<ProfileFormValues> = {};

        // Validate profile name
        if (!values.name.trim()) {
          errors.name = "Profile name is required";
        }

        // Validate backup reminder period (if enabled)
        if (
          values.backupReminderPeriod !== -1 &&
          values.backupReminderPeriod <= 0
        ) {
          errors.backupReminderPeriod =
            "Backup reminder period must be greater than 0";
        }

        return errors;
      },
      onSubmit: async (values) => {
        try {
          // Update the profile with the standard profile properties
          const updatedProfile = {
            name: values.name,
            activePadBehavior: values.activePadBehavior,
            backupReminderPeriod: values.backupReminderPeriod,
          };

          await updateProfile(profile.id!, updatedProfile);
          console.log(`Profile ${profile.id} updated successfully`);
        } catch (error) {
          console.error("Failed to update profile:", error);
          throw error; // Re-throw to prevent modal from closing
        }
      },
      confirmText: "Save Changes",
      size: "md",
    });
  };

  return { openProfileEditor };
}
