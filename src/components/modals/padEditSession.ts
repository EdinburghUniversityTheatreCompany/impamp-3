/**
 * Bookkeeping for one open pad editor, shared between `EditPadModalContent`
 * and the modal's `onSubmit`.
 *
 * Picking a sound writes its blob to IndexedDB straight away — the sound list
 * and the waveform trimmer both read it back by id, so it has to exist before
 * it can be shown or trimmed. That makes every added sound provisional until
 * the pad configuration referencing it is saved, and `onSubmit` is the only
 * place that knows a save happened.
 *
 * In its own module, away from the component, so that `usePadInteractions` can
 * open the editor without importing it. The editor's subtree reaches
 * `EditPadForm`, which pulls in `@hello-pangea/dnd`; a static import of the
 * component put the whole of that in the page's first-load graph for a modal
 * most sessions never open.
 *
 * @module components/modals/padEditSession
 */

export interface PadEditSession {
  /** Audio file ids written during this edit. */
  provisionalFileIds: Set<number>;
  /** Set by onSubmit, once persisted, to the ids the saved pad references. */
  savedFileIds: number[] | null;
}

export function createPadEditSession(): PadEditSession {
  return { provisionalFileIds: new Set(), savedFileIds: null };
}
