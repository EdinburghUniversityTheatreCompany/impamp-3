"use client";

import React, { Suspense } from "react";
import { useUIStore } from "@/store/uiStore";
import Modal from "./Modal";
import { getModalComponent } from "./modals/modalRegistry";

const ModalRenderer: React.FC = () => {
  // Select individual state pieces
  const isModalOpen = useUIStore((state) => state.isModalOpen);
  const modalConfig = useUIStore((state) => state.modalConfig);
  const closeModal = useUIStore((state) => state.closeModal);

  if (!isModalOpen || !modalConfig) {
    return null;
  }

  // The actual onConfirm logic is part of the modalConfig passed when opening
  // The Modal component itself just calls the provided onConfirm/onCancel
  const handleConfirm = async () => {
    if (modalConfig.onConfirm) {
      await modalConfig.onConfirm();
    }
    // Decide if the modal should close automatically after confirm.
    // Often, the action triggered by onConfirm might navigate away or refresh,
    // making explicit closing unnecessary, or the caller might want to close it manually.
    // Let's keep it simple: the confirm action itself doesn't close the modal here.
    // The caller can call closeModal() within their onConfirm if needed.
  };

  // Loading fallback component for lazy-loaded modals
  const LoadingSpinner = () => (
    <div className="flex items-center justify-center p-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <span className="ml-2 text-gray-600">Loading...</span>
    </div>
  );

  // Render modal content - either direct content or lazy-loaded component
  const renderModalContent = () => {
    // If modalType is specified, use lazy loading
    if (modalConfig.modalType) {
      const LazyModalComponent = getModalComponent(modalConfig.modalType);
      return (
        <Suspense fallback={<LoadingSpinner />}>
          <LazyModalComponent {...(modalConfig.modalProps || {})} />
        </Suspense>
      );
    }

    // Otherwise, render direct content (backwards compatibility)
    return modalConfig.content;
  };

  return (
    <Modal
      isOpen={isModalOpen}
      onClose={closeModal} // Use the store's closeModal action
      title={modalConfig.title}
      confirmText={modalConfig.confirmText}
      cancelText={modalConfig.cancelText}
      onConfirm={handleConfirm} // Pass the wrapper handleConfirm
      onCancel={modalConfig.onCancel} // Pass the specific onCancel from config if any
      showConfirmButton={modalConfig.showConfirmButton}
      showCancelButton={modalConfig.showCancelButton}
      size={modalConfig.size} // Pass the size prop
    >
      {renderModalContent()}
    </Modal>
  );
};

export default ModalRenderer;
