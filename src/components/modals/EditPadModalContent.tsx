/**
 * Edit Pad Modal Content
 *
 * Modal content for editing pad name, playback type and sound list.
 * This is a wrapper around EditPadForm to maintain backwards compatibility
 * with existing code that uses this component directly.
 *
 * @module components/modals/EditPadModalContent
 */

import React from "react";
import EditPadForm from "./EditPadForm";
import type { PadFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import type { PadConfiguration } from "@/lib/db";

interface EditPadModalContentProps {
  initialPadConfig: PadConfiguration;
  profileId: number;
  pageIndex: number;
  padIndex: number;
}

export interface EditPadModalContentRef {
  getCurrentState: () => Omit<
    PadConfiguration,
    "id" | "createdAt" | "updatedAt"
  >;
}

/**
 * Legacy component for editing pad properties
 * Uses the new form pattern internally but maintains the old interface
 * for backwards compatibility with existing code
 */
const EditPadModalContent = React.forwardRef<
  EditPadModalContentRef,
  EditPadModalContentProps
>(({ initialPadConfig, profileId, pageIndex, padIndex }, ref) => {
  // Use React state to manage form values and padState
  const [formValues, setFormValues] = React.useState<PadFormValues>({
    name: initialPadConfig.name || "Empty Pad",
    playbackType: initialPadConfig.playbackType || "sequential",
    audioFileIds: initialPadConfig.audioFileIds || [],
  });

  // Memoized padState to prevent unnecessary recalculations
  const padState = React.useMemo(
    () => ({
      ...initialPadConfig,
      profileId,
      pageIndex,
      padIndex,
      name: formValues.name,
      playbackType: formValues.playbackType,
      audioFileIds: formValues.audioFileIds,
    }),
    [formValues, initialPadConfig, profileId, pageIndex, padIndex],
  );

  // Create mock props that match what useFormModal would provide
  const mockFormProps: FormModalRenderProps<PadFormValues> & {
    profileId: number;
  } = {
    values: formValues,
    updateValue: (field, value) => {
      console.log(`Updating field: ${field}`, value); // Debug log
      setFormValues((prevValues) => ({
        ...prevValues,
        [field]: value,
      }));
    },
    setValues: (newValues) => {
      console.log("Setting all values:", newValues); // Debug log
      setFormValues(newValues);
    },
    errors: {},
    isSubmitting: false,
    profileId,
  };

  // Expose getCurrentState via ref
  React.useImperativeHandle(ref, () => ({
    getCurrentState: () => ({
      profileId,
      pageIndex,
      padIndex,
      name: padState.name,
      playbackType: padState.playbackType,
      audioFileIds: padState.audioFileIds,
      keyBinding: initialPadConfig.keyBinding, // Preserve original keybinding
    }),
  }));

  return <EditPadForm {...mockFormProps} />;
});

EditPadModalContent.displayName = "EditPadModalContent";

export default EditPadModalContent;
