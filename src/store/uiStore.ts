import { create } from "zustand";
import React from "react";
import { ModalType } from "@/components/modals/modalRegistry";

type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

interface ModalConfig {
  title?: string;
  content?: React.ReactNode; // The component to render inside the modal (for direct content)
  modalType?: ModalType; // Type for lazy-loaded modals
  modalProps?: Record<string, unknown>; // Props to pass to the lazy-loaded modal
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void | Promise<void>; // Callback for confirm action
  onCancel?: () => void | Promise<void>; // Callback for cancel/close action
  showConfirmButton?: boolean;
  showCancelButton?: boolean;
  size?: ModalSize; // Controls the modal width
}

interface UIState {
  isModalOpen: boolean;
  modalConfig: ModalConfig | null;
  openModal: (config: ModalConfig) => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  isModalOpen: false,
  modalConfig: null,

  openModal: (config) => {
    // Ensure default values for buttons if not provided
    const fullConfig = {
      showConfirmButton: true, // Default to true
      showCancelButton: true, // Default to true
      ...config,
    };
    set({ isModalOpen: true, modalConfig: fullConfig });
  },

  // closeModal should only handle closing the modal state.
  // Callbacks like onCancel should be handled by the specific action triggering the close (e.g., Cancel button).
  closeModal: () => {
    set({ isModalOpen: false, modalConfig: null });
  },
}));

// Selector hook for convenience
export const selectModalState = (state: UIState) => ({
  isModalOpen: state.isModalOpen,
  modalConfig: state.modalConfig,
  openModal: state.openModal,
  closeModal: state.closeModal,
});
