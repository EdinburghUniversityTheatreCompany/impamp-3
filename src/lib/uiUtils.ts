import { useUIStore } from "@/store/uiStore";
import { ModalType } from "@/components/modals/modalRegistry";

/**
 * Opens the standard Help Modal using the UI store with lazy loading.
 */
export const openHelpModal = () => {
  // Get the openModal function directly from the store's state
  const openModalFn = useUIStore.getState().openModal;

  openModalFn({
    title: "ImpAmp3 Help",
    modalType: ModalType.HELP,
    modalProps: {},
    showConfirmButton: false,
    showCancelButton: true,
    cancelText: "Close",
  });
};
