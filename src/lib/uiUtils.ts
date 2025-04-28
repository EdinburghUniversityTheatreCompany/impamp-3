import { useUIStore } from "@/store/uiStore";
import HelpModalContent from "@/components/modals/HelpModalContent";
import React from "react";

/**
 * Opens the standard Help Modal using the UI store.
 */
export const openHelpModal = () => {
  // Get the openModal function directly from the store's state
  const openModalFn = useUIStore.getState().openModal;

  openModalFn({
    title: "ImpAmp3 Help",
    content: React.createElement(HelpModalContent), // Use React.createElement for consistency if needed elsewhere
    showConfirmButton: false,
    showCancelButton: true,
    cancelText: "Close",
  });
};
