"use client";

/**
 * Edit Bank Modal Content
 *
 * Modal content for editing bank name and emergency status.
 * This is a wrapper around EditBankForm to maintain backwards compatibility
 * with existing code that uses this component directly.
 *
 * @module components/modals/EditBankModalContent
 */

import React from "react";
import EditBankForm from "./EditBankForm";
import type { BankFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";

interface EditBankModalContentProps {
  initialName: string;
  initialIsEmergency: boolean;
  // Callback to pass the current state up to the caller
  onDataChange: (data: { name: string; isEmergency: boolean }) => void;
}

/**
 * Legacy component for editing bank properties
 * Uses the new form pattern internally but maintains the old interface
 * for backwards compatibility
 */
const EditBankModalContent: React.FC<EditBankModalContentProps> = ({
  initialName,
  initialIsEmergency,
  onDataChange,
}) => {
  // Create mock props that match what useFormModal would provide
  const mockFormProps: FormModalRenderProps<BankFormValues> = {
    values: {
      name: initialName,
      isEmergency: initialIsEmergency,
    },
    updateValue: (field, value) => {
      const newValues = {
        ...mockFormProps.values,
        [field]: value,
      };
      mockFormProps.values = newValues;
      onDataChange(newValues);
    },
    setValues: (newValues) => {
      mockFormProps.values = newValues;
      onDataChange(newValues);
    },
    errors: {},
    isSubmitting: false,
  };

  return <EditBankForm {...mockFormProps} />;
};

export default EditBankModalContent;
