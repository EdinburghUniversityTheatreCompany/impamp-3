/**
 * Toggle Mode Hook
 *
 * Provides functionality for toggling application modes
 *
 * @module hooks/useToggleMode
 */

import { useCallback } from "react";
import { useProfileStore } from "@/store/profileStore";

/**
 * Hook that provides functionality for toggling application modes
 *
 * @returns Object containing functions and state related to mode toggling
 */
export function useToggleMode() {
  // Delete/Move Mode
  const isDeleteMoveMode = useProfileStore((state) => state.isDeleteMoveMode);
  const toggleDeleteMoveMode = useProfileStore(
    (state) => state.toggleDeleteMoveMode,
  );
  const storeSetDeleteMoveMode = useProfileStore(
    (state) => state.setDeleteMoveMode,
  );

  // Edit Mode
  const isEditMode = useProfileStore((state) => state.isEditMode);
  const storeSetEditMode = useProfileStore((state) => state.setEditMode);

  /**
   * Enables or disables delete/move mode
   *
   * @param enable - Whether to enable (true) or disable (false) delete/move mode
   */
  const setDeleteMoveMode = useCallback(
    (enable: boolean) => {
      if (enable !== isDeleteMoveMode) {
        if (storeSetDeleteMoveMode) {
          storeSetDeleteMoveMode(enable);
        } else {
          // Fallback if direct setter isn't available
          toggleDeleteMoveMode();
        }
      }
    },
    [isDeleteMoveMode, toggleDeleteMoveMode, storeSetDeleteMoveMode],
  );

  /**
   * Enables or disables edit mode
   *
   * @param enable - Whether to enable (true) or disable (false) edit mode
   */
  const toggleEditMode = useCallback(
    (enable: boolean) => {
      if (enable !== isEditMode) {
        storeSetEditMode(enable);
      }
    },
    [isEditMode, storeSetEditMode],
  );

  return {
    // Delete/Move Mode
    isDeleteMoveMode,
    toggleDeleteMoveMode,
    setDeleteMoveMode,

    // Edit Mode
    isEditMode,
    setEditMode: storeSetEditMode,
    toggleEditMode,
  };
}
