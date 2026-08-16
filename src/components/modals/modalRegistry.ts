/**
 * Modal Registry for Dynamic Loading
 *
 * This registry enables lazy loading of modal components to reduce initial bundle size.
 * Each modal component is loaded only when needed.
 */

import { ComponentType, lazy } from "react";

// Modal types enum for type safety
export enum ModalType {
  // CONFIRM and PROMPT used to be here. Nothing referenced them: the two
  // smallest modals are rendered directly as `content` by their callers
  // (`usePadInteractions`, `app/page.tsx`), so the lazy-loading indirection
  // was bypassed for exactly the components that least needed it. The four
  // that remain are 500-600 line components, which is what this is for.
  BULK_IMPORT = "bulkImport",
  CONFLICT_RESOLUTION = "conflictResolution",
  HELP = "help",
  LOUDNESS_OVERVIEW = "loudnessOverview",
}

// Lazy load all modal components
const modalComponents = {
  [ModalType.BULK_IMPORT]: lazy(() => import("./BulkImportModalContent")),
  [ModalType.CONFLICT_RESOLUTION]: lazy(() =>
    import("./ConflictResolutionModal").then((module) => ({
      default: module.ConflictResolutionModal,
    })),
  ),
  [ModalType.HELP]: lazy(() => import("./HelpModalContent")),
  [ModalType.LOUDNESS_OVERVIEW]: lazy(
    () => import("./LoudnessOverviewModalContent"),
  ),
} as const;

/**
 * Get a modal component by type
 * @param modalType The type of modal to load
 * @returns The lazy-loaded modal component
 */
export function getModalComponent(modalType: ModalType): ComponentType {
  const component = modalComponents[modalType];
  if (!component) {
    throw new Error(`Modal component not found for type: ${modalType}`);
  }
  return component as ComponentType;
}

export { modalComponents };
