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
import { deleteUnreferencedAudioFiles } from "@/lib/db";
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
      const discardable = [...session.provisionalFileIds].filter(
        (fileId) => !kept.has(fileId),
      );
      // Not `deleteAudioFile`, which deletes by id and checks nothing. Adds
      // reuse by content hash, so a "provisional" id is routinely the id of a
      // row that already existed and that some pad — this profile's or
      // another's, since audio rows are global — still names. Deleting it
      // takes that pad's sound with it. This helper decides and deletes in one
      // transaction, keeping anything still referenced, so what goes is only
      // what this edit actually created.
      deleteUnreferencedAudioFiles(discardable).catch((error) =>
        console.error("Failed to discard unsaved audio files:", error),
      );
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
