/**
 * Modal Registry for Dynamic Loading
 *
 * This registry enables lazy loading of modal components to reduce initial bundle size.
 * Each modal component is loaded only when needed.
 */

import { ComponentType, lazy } from "react";

// Modal types enum for type safety
export enum ModalType {
  CONFIRM = "confirm",
  PROMPT = "prompt",
  BULK_IMPORT = "bulkImport",
  CONFLICT_RESOLUTION = "conflictResolution",
  HELP = "help",
  EDIT_BANK = "editBank",
  EDIT_PAD = "editPad",
}

// Lazy load all modal components
const modalComponents = {
  [ModalType.CONFIRM]: lazy(() => import("./ConfirmModalContent")),
  [ModalType.PROMPT]: lazy(() => import("./PromptModalContent")),
  [ModalType.BULK_IMPORT]: lazy(() => import("./BulkImportModalContent")),
  [ModalType.CONFLICT_RESOLUTION]: lazy(() =>
    import("./ConflictResolutionModal").then((module) => ({
      default: module.ConflictResolutionModal,
    })),
  ),
  [ModalType.HELP]: lazy(() => import("./HelpModalContent")),
  [ModalType.EDIT_BANK]: lazy(() => import("./EditBankModalContent")),
  [ModalType.EDIT_PAD]: lazy(() => import("./EditPadModalContent")),
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

/**
 * Check if a modal type exists in the registry
 * @param modalType The modal type to check
 * @returns True if the modal type exists
 */
export function hasModalComponent(modalType: ModalType): boolean {
  return modalType in modalComponents;
}

export { modalComponents };
