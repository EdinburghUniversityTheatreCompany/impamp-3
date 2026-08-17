"use client";

import React, { useEffect, useId, useRef } from "react";
import { useEscapeToClose } from "@/hooks/modal/useEscapeToClose";

/**
 * Everything the browser would put in the tab order.
 *
 * `[tabindex]:not([tabindex="-1"])` is what catches the pads and any other
 * hand-rolled control; the `:not([disabled])` clauses are needed because a
 * disabled control still matches its bare tag selector.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The focusable children of `root`, in tab order, minus the ones nobody can see.
 *
 * Visibility is judged by `getClientRects()` rather than `offsetParent`: the
 * dialog is `position: fixed`, and `offsetParent` is null for everything inside
 * a fixed ancestor, which would have reported an empty dialog every time.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0);
}

type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>; // Optional specific cancel handler
  showConfirmButton?: boolean;
  showCancelButton?: boolean;
  size?: ModalSize; // Controls the modal width
}

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  showConfirmButton = true,
  showCancelButton = true,
  size = "sm",
}) => {
  // Escape closes the modal, and must not reach the global keyboard listener
  // (where it doubles as the panic button). Shared with the profile manager,
  // which is the one overlay outside this system and went without it.
  useEscapeToClose(isOpen, onClose);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Move focus in on open, and hand it back on close.
  //
  // Without this, opening any modal left focus on the trigger *behind* the
  // overlay: a screen reader announced nothing and carried on reading the
  // obscured page, and closing dropped focus to <body> so the next Tab
  // restarted from the top of the document.
  //
  // The dialog container takes the focus rather than its first control, which
  // is why it carries tabIndex={-1}. Focusing the first control instead would
  // skip the title for a screen reader, and the modals here are lazy — the
  // first control does not exist yet when this runs.
  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();

    return () => {
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  // Keep Tab inside the dialog.
  //
  // `useKeyboardListener` suppresses Tab app-wide but bails while any overlay
  // is open, so inside a modal Tab is the browser's again — and with nothing
  // holding it, it walked straight out into the page underneath.
  const handleTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const root = dialogRef.current;
    if (!root) return;

    const focusable = focusableWithin(root);
    if (focusable.length === 0) {
      // Nothing to move to, so the only correct move is not to move.
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    // Only the two ends need handling; in between, the browser's own order is
    // the right one. The container counts as "before the first" so that the
    // very first Shift+Tab after opening wraps to the end rather than leaving.
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (onConfirm) {
      await onConfirm();
    }
    // Note: Closing the modal after confirm might be handled by the caller
    // or we could enforce it here. Let's keep it flexible for now.
    // onClose(); // Optionally close after confirm
  };

  const handleCancel = async () => {
    if (onCancel) {
      await onCancel();
    }
    onClose(); // Always close on cancel
  };

  // Prevent clicks inside the modal content from closing it
  const stopPropagation = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Define size classes for modal width
  const sizeClasses = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
    full: "max-w-full w-[95vw]",
  };

  return (
    <div
      data-testid="custom-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 transition-opacity duration-300 overflow-y-auto py-6"
      onClick={onClose} // Close when clicking the overlay
    >
      <div
        ref={dialogRef}
        data-testid="custom-modal"
        role="dialog"
        aria-modal="true"
        // Named by its own heading where there is one. Falling back to a
        // generic label is better than an unnamed dialog, which assistive tech
        // announces as just "dialog".
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Dialog"}
        tabIndex={-1}
        className={`relative bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full mx-4 transition-transform duration-300 transform scale-100 outline-none ${sizeClasses[size]}`}
        onClick={stopPropagation} // Stop propagation for clicks inside the modal
        onKeyDown={handleTabKey}
      >
        {/* Close Button */}
        <button
          data-testid="modal-close-button"
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          aria-label="Close modal"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        {/* Title */}
        {title && (
          <h2
            id={titleId}
            className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100"
            data-testid="modal-title"
          >
            {title}
          </h2>
        )}

        {/* Content */}
        <div className="mb-6" data-testid="modal-content">
          {children}
        </div>

        {/* Action Buttons */}
        {(showConfirmButton || showCancelButton) && (
          <div className="flex justify-end space-x-3">
            {showCancelButton && (
              <button
                data-testid="modal-cancel-button"
                onClick={handleCancel}
                className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 dark:text-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-gray-800 transition-colors"
              >
                {cancelText}
              </button>
            )}
            {showConfirmButton && onConfirm && (
              <button
                data-testid="modal-confirm-button"
                onClick={handleConfirm}
                className="px-4 py-2 rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-800 transition-colors"
              >
                {confirmText}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
