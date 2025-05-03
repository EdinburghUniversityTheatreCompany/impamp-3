/**
 * Modal Hook
 *
 * Provides a type-safe way to work with the modal system
 *
 * @module hooks/modal/useModal
 */

import { useCallback } from "react";
import { useUIStore } from "@/store/uiStore";
import type { ReactNode } from "react";
import React from "react";

// Modal size options
export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

// Base modal options shared by all modal types
export interface BaseModalOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  showConfirmButton?: boolean;
  showCancelButton?: boolean;
  size?: ModalSize;
}

// Specific options for confirmation modals
export interface ConfirmModalOptions extends BaseModalOptions {
  message: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

// Specific options for custom content modals
export interface ContentModalOptions<T = unknown> extends BaseModalOptions {
  content: ReactNode;
  data?: T;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

/**
 * Custom hook for working with modals
 *
 * Provides type-safe functions for common modal operations
 *
 * @returns Object with modal functions
 */
export function useModal() {
  const { openModal, closeModal, isModalOpen } = useUIStore();

  /**
   * Opens a confirmation modal with the given options
   *
   * @param options - Configuration for the confirmation modal
   */
  const openConfirmModal = useCallback(
    (options: ConfirmModalOptions) => {
      const { message, onConfirm, onCancel, ...baseOptions } = options;

      openModal({
        content: (
          <div className="text-gray-700 dark:text-gray-300">
            <p>{message}</p>
          </div>
        ),
        onConfirm,
        onCancel,
        ...baseOptions,
      });
    },
    [openModal],
  );

  /**
   * Opens a modal with custom content
   *
   * @param options - Configuration for the content modal
   */
  const openContentModal = useCallback(
    function openContentModalFn<T>(options: ContentModalOptions<T>) {
      const { content, onConfirm, onCancel, ...baseOptions } = options;

      openModal({
        content,
        onConfirm,
        onCancel,
        ...baseOptions,
      });
    },
    [openModal],
  );

  /**
   * Closes the currently open modal
   */
  const close = useCallback(() => {
    closeModal();
  }, [closeModal]);

  return {
    openConfirmModal,
    openContentModal,
    closeModal: close,
    isModalOpen,
  };
}
