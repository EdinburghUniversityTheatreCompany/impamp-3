/**
 * Edit Pad Modal Content
 *
 * The pad editor's `renderForm` for useFormModal: it renders EditPadForm and
 * owns the lifecycle of sounds added during the edit.
 *
 * @module components/modals/EditPadModalContent
 */

import React from "react";
import EditPadForm from "./EditPadForm";
import type { PadFormValues } from "@/types/forms";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import { deleteAudioFile } from "@/lib/db";
// The session lives in its own module so that opening this editor does not
// require importing it — see `padEditSession` for why that matters to the
// first-load bundle.
import type { PadEditSession } from "./padEditSession";

interface EditPadModalContentProps extends FormModalRenderProps<PadFormValues> {
  session: PadEditSession;
}

const EditPadModalContent: React.FC<EditPadModalContentProps> = ({
  session,
  ...formProps
}) => {
  // Discard on unmount rather than through the modal's onCancel: onCancel runs
  // only for the Cancel button, while Escape, the X and an overlay click all
  // close the modal straight through onClose. Unmount is the one path every
  // dismissal takes.
  React.useEffect(() => {
    return () => {
      const kept = new Set(session.savedFileIds ?? []);
      for (const fileId of session.provisionalFileIds) {
        if (kept.has(fileId)) continue;
        deleteAudioFile(fileId).catch((error) =>
          console.error(
            `Failed to discard unsaved audio file ${fileId}:`,
            error,
          ),
        );
      }
    };
  }, [session]);

  return (
    <EditPadForm
      {...formProps}
      onSoundsAdded={(fileIds) => {
        for (const fileId of fileIds) {
          session.provisionalFileIds.add(fileId);
        }
      }}
    />
  );
};

EditPadModalContent.displayName = "EditPadModalContent";

export default EditPadModalContent;
