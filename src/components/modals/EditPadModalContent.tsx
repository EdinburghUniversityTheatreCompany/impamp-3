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
import { deleteAudioFile, DEFAULT_PLAYBACK_TYPE } from "@/lib/db";
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
  /**
   * Tells the modal its state reached IndexedDB, so the sounds added during
   * this session are no longer provisional. Call it only after the pad
   * configuration has actually been persisted — anything still provisional
   * when the modal unmounts is deleted.
   */
  markSaved: () => void;
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
    playbackType: initialPadConfig.playbackType || DEFAULT_PLAYBACK_TYPE,
    audioFileIds: initialPadConfig.audioFileIds || [],
    audioTrimSettings: initialPadConfig.audioTrimSettings,
    isDisabled: initialPadConfig.isDisabled ?? false,
  });

  // Sounds added through the file picker during this modal session. They are
  // written to IndexedDB immediately — the trimmer and the sound list both
  // read the blob back by id — so they are provisional until the pad
  // configuration that references them is saved. Anything still provisional
  // when this component unmounts is deleted again, whichever way the modal was
  // dismissed: only the Cancel button reaches the modal's onCancel, while
  // Escape, the X and an overlay click all close it directly.
  const provisionalFileIdsRef = React.useRef<Set<number>>(new Set());
  const savedFileIdsRef = React.useRef<number[] | null>(null);

  React.useEffect(() => {
    return () => {
      const kept = new Set(savedFileIdsRef.current ?? []);
      for (const fileId of provisionalFileIdsRef.current) {
        if (kept.has(fileId)) continue;
        deleteAudioFile(fileId).catch((error) =>
          console.error(
            `Failed to discard unsaved audio file ${fileId}:`,
            error,
          ),
        );
      }
    };
  }, []);

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
      audioTrimSettings: formValues.audioTrimSettings,
      isDisabled: formValues.isDisabled,
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
      audioTrimSettings: padState.audioTrimSettings,
      isDisabled: padState.isDisabled,
      keyBinding: initialPadConfig.keyBinding, // Preserve original keybinding
    }),
    markSaved: () => {
      savedFileIdsRef.current = padState.audioFileIds;
    },
  }));

  return (
    <EditPadForm
      {...mockFormProps}
      onSoundsAdded={(fileIds) => {
        for (const fileId of fileIds) {
          provisionalFileIdsRef.current.add(fileId);
        }
      }}
    />
  );
});

EditPadModalContent.displayName = "EditPadModalContent";

export default EditPadModalContent;
