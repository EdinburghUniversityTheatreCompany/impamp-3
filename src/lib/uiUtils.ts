import { useUIStore } from "@/store/uiStore";
import { ModalType } from "@/components/modals/modalRegistry";
import { hasSeenWelcomeTour, markWelcomeTourSeen } from "@/lib/firstRun";

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

/**
 * Opens the first-use tour (issue #8).
 *
 * `onCancel` records the answer as well, because the shared `Modal` closes on
 * Escape and on the backdrop without going near the tour's own buttons — and
 * someone who dismisses it that way is the person least likely to want it
 * again next load.
 */
export const openWelcomeTour = () => {
  const openModalFn = useUIStore.getState().openModal;

  openModalFn({
    title: "Welcome to ImpAmp",
    modalType: ModalType.WELCOME_TOUR,
    modalProps: {},
    showConfirmButton: false,
    showCancelButton: false,
    onCancel: markWelcomeTourSeen,
  });
};

/**
 * Whether to offer the tour unprompted.
 *
 * Two conditions, and the second is the important one. Not seen on this
 * device, **and** the board is empty — so the tour cannot appear over a board
 * someone has built, which for a live performance tool is the difference
 * between a tutorial and an incident. A returning user who has cleared their
 * site data gets no modal in front of their cues; they get it only on a board
 * with nothing to interrupt.
 *
 * @param configuredPadCount - How many pads in the active profile hold sounds
 */
export const shouldOfferWelcomeTour = (configuredPadCount: number): boolean =>
  configuredPadCount === 0 && !hasSeenWelcomeTour();
