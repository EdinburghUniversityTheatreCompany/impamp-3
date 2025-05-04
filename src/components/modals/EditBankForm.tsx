/**
 * Edit Bank Form Component
 *
 * Form for editing bank name and emergency status
 *
 * @module components/modals/EditBankForm
 */

import React, { useEffect, useRef } from "react";
import { FormField, TextInput, Checkbox } from "@/components/forms";
import type { BankFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";

/**
 * Form component for editing a bank's properties
 */
const EditBankForm: React.FC<FormModalRenderProps<BankFormValues>> = ({
  values,
  updateValue,
  errors,
  isSubmitting,
}) => {
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus the name input field when the form mounts
  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  return (
    <div className="space-y-4 relative">
      {isSubmitting && (
        <div className="absolute inset-0 bg-white/50 dark:bg-gray-800/50 flex items-center justify-center z-10">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      )}
      {/* Bank Name Input */}
      <FormField id="bank-name-input" label="Bank Name" error={errors.name}>
        <TextInput
          id="bank-name-input"
          value={values.name}
          onChange={(value) => updateValue("name", value)}
          autoFocus
          selectOnFocus
          error={errors.name}
          data-testid="bank-name-input"
        />
      </FormField>

      {/* Emergency Checkbox */}
      <Checkbox
        id="emergency-checkbox"
        label="Mark as Emergency Bank"
        description="(Can be triggered with the Enter key)"
        checked={values.isEmergency}
        onChange={(checked) => updateValue("isEmergency", checked)}
        error={errors.isEmergency}
        data-testid="emergency-checkbox"
      />
    </div>
  );
};

export default EditBankForm;
