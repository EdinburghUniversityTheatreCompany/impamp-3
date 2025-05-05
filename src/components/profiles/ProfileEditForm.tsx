/**
 * Profile Edit Form Component
 *
 * Form for editing profile settings like name, backup reminder, active pad behavior, and fadeout duration
 *
 * @module components/profiles/ProfileEditForm
 */

import React from "react";
import { FormField, TextInput, Checkbox, RadioGroup } from "@/components/forms";
import type { ProfileFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";

/**
 * Form component for editing profile properties
 */
const ProfileEditForm: React.FC<FormModalRenderProps<ProfileFormValues>> = ({
  values,
  updateValue,
  errors,
  isSubmitting,
}) => {
  // Calculate days from milliseconds for display in the form
  const MS_IN_DAY = 1000 * 60 * 60 * 24;
  const reminderDays =
    values.backupReminderPeriod === -1
      ? "30" // Default value when disabled
      : Math.round(values.backupReminderPeriod / MS_IN_DAY).toString();

  const isReminderDisabled = values.backupReminderPeriod === -1;

  // Handle reminder period changes
  const handleReminderChange = (value: string) => {
    if (isReminderDisabled) return;

    const days = parseInt(value, 10);
    if (!isNaN(days) && days > 0) {
      updateValue("backupReminderPeriod", days * MS_IN_DAY);
    }
  };

  // Toggle reminder disabled status
  const handleReminderDisabledChange = (checked: boolean) => {
    updateValue(
      "backupReminderPeriod",
      checked ? -1 : parseInt(reminderDays, 10) * MS_IN_DAY,
    );
  };

  return (
    <div className="space-y-4 relative">
      {isSubmitting && (
        <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      )}

      {/* Profile Name */}
      <FormField id="profileName" label="Profile Name" error={errors.name}>
        <TextInput
          id="profileName"
          value={values.name}
          onChange={(value) => updateValue("name", value)}
          autoFocus
          selectOnFocus
          error={errors.name}
        />
      </FormField>

      {/* Active Pad Behavior */}
      <FormField
        id="activePadBehavior"
        label="When a pad is triggered while already playing:"
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
              description: "The sound will stop immediately.",
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
      </FormField>

      {/* Backup Reminder Settings */}
      <div className="space-y-2">
        <FormField
          id="backupReminderPeriod"
          label="Backup Reminder Period (days)"
          error={errors.backupReminderPeriod as string}
        >
          <div className="flex items-center space-x-4">
            <TextInput
              id="backupReminderPeriod"
              type="number"
              value={reminderDays}
              onChange={handleReminderChange}
              className="w-20"
              disabled={isReminderDisabled}
              error={errors.backupReminderPeriod as string}
            />
            <Checkbox
              id="disableReminders"
              label="Disable Reminders"
              checked={isReminderDisabled}
              onChange={handleReminderDisabledChange}
            />
          </div>
        </FormField>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {isReminderDisabled
            ? "You will not receive reminders to back up this profile."
            : `You will be reminded to back up this profile every ${reminderDays} days.`}
        </p>
      </div>
    </div>
  );
};

export default ProfileEditForm;
