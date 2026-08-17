/**
 * Modal Hook
 *
 * Provides a type-safe way to work with the modal system
 *
 * @module hooks/modal/useModal
 */

import { useCallback } from "react";
import { useUIStore } from "@/store/uiStore";
import { ModalType } from "@/components/modals/modalRegistry";
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

// Specific options for lazy-loaded modal components
export interface LazyModalOptions<T = unknown> extends BaseModalOptions {
  modalType: ModalType;
  modalProps?: T;
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
  // Actions only, deliberately. This hook used to subscribe to `isModalOpen`
  // as well, whether the caller wanted it or not, and it is reached from
  // `PadGrid → usePadInteractions → useFormModal → useModal` — so opening or
  // closing *any* modal re-rendered the grid and all 48 of its pads. That is
  // exactly the cost `usePadInteractions` selects `openModal` and `closeModal`
  // individually to avoid, and says so in a comment, defeated one hook down.
  //
  // Nothing ever read the `isModalOpen` this hook returned: `ModalRenderer`,
  // `useKeyboardListener` and `useIsAnyOverlayOpen` all take it from the store
  // themselves, which is what a component that genuinely re-renders on modal
  // state should keep doing.
  const openModal = useUIStore((state) => state.openModal);
  const closeModal = useUIStore((state) => state.closeModal);

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
   * Opens a lazy-loaded modal component
   *
   * @param options - Configuration for the lazy modal
   */
  const openLazyModal = useCallback(
    function openLazyModalFn<T>(options: LazyModalOptions<T>) {
      const { modalType, modalProps, onConfirm, onCancel, ...baseOptions } =
        options;

      openModal({
        modalType,
        modalProps: modalProps as Record<string, unknown>,
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
    openLazyModal,
    closeModal: close,
  };
}
