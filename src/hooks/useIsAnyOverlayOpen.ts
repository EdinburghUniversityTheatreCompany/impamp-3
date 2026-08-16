"use client";

/**
 * Whether anything is on top of the soundboard and should own the keyboard.
 *
 * "An overlay is open" is tracked in three unconnected places — `uiStore` for
 * the modal system, a React context for search, and `profileStore` for the
 * profile manager — and the keyboard listener guarded on two of them. The
 * profile manager is rendered outside the modal system, so with it open and
 * focus anywhere that is not a text field (a button, the backdrop) `q`
 * triggered a pad, `1` switched bank behind the overlay, Enter fired an
 * emergency sound, and Escape ran the panic stop instead of closing the
 * manager.
 *
 * One place to ask, so a fourth overlay cannot be forgotten in the same way.
 * The flags themselves still live where they live; consolidating those is a
 * store-shaped change, and this is a keyboard-shaped bug.
 *
 * @module hooks/useIsAnyOverlayOpen
 */

import { useUIStore } from "@/store/uiStore";
import { useProfileStore } from "@/store/profileStore";
import { useSearchContext } from "@/components/search/SearchProvider";

export function useIsAnyOverlayOpen(): boolean {
  const isModalOpen = useUIStore((state) => state.isModalOpen);
  const isProfileManagerOpen = useProfileStore(
    (state) => state.isProfileManagerOpen,
  );
  const { isSearchModalOpen } = useSearchContext();

  return isModalOpen || isProfileManagerOpen || isSearchModalOpen;
}
