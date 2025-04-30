"use client";

import React from "react";

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 transition-opacity duration-300 overflow-y-auto py-6"
      onClick={onClose} // Close when clicking the overlay
    >
      <div
        data-testid="custom-modal"
        className={`relative bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full mx-4 transition-transform duration-300 transform scale-100 ${sizeClasses[size]}`}
        onClick={stopPropagation} // Stop propagation for clicks inside the modal
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
