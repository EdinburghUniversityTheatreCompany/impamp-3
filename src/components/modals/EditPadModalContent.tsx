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
import { beginAudioImport, deleteUnreferencedAudioFiles } from "@/lib/db";
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
    // Held for as long as the editor is open. Picking a sound writes its row
    // straight away and the pad naming it is written on Save, so between the
    // two there is a row nothing references — the window every audio deleter
    // is entitled to delete in, and the writers' half of the rule the deleters
    // keep with `settleAudioImports()`. No single call spans it: the two
    // halves are two user actions, which is why this is `beginAudioImport`
    // rather than `withAudioImportInProgress`.
    //
    // The cost is that an audio deleter started while the editor is open waits
    // for it to close. Nothing reachable pays it: every deleter in the app is
    // a button on the profile manager or the editor's own discard, and
    // `uiStore` holds exactly one modal, so the profile manager cannot be open
    // at the same time as this.
    const releaseAudioHold = beginAudioImport();
    return () => {
      // First, and in the same synchronous block as the discard below.
      // `settleAudioImports` waits for every registered import and cannot tell
      // which one its caller holds, so a deleter that reaches it while this
      // hold is open waits for the hold that is waiting for it — a hung tab
      // rather than an error.
      releaseAudioHold();
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
      // what this edit actually created — and it waits for the imports in
      // flight first, which is the other half of the same problem: a row a
      // background sync has been handed but not yet named in a pad is
      // referenced by nothing at all, and was deleted here until it did.
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
