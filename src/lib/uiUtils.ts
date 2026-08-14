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

/**
 * Opens the loudness overview modal using the UI store with lazy loading.
 *
 * `size: "full"` because the table is wide (eight sortable columns plus an
 * inline gain control) — the default modal widths clip it.
 */
export const openLoudnessOverviewModal = () => {
  const openModalFn = useUIStore.getState().openModal;

  openModalFn({
    title: "Loudness overview",
    modalType: ModalType.LOUDNESS_OVERVIEW,
    modalProps: {},
    showConfirmButton: false,
    showCancelButton: true,
    cancelText: "Close",
    size: "full",
  });
};
