/**
 * Loading State Store
 *
 * Manages loading states for audio files across all trigger sources
 * (pad clicks, keyboard shortcuts, search results, armed tracks)
 *
 * @module store/loadingStore
 */

import { create } from "zustand";
import { LoadingState } from "@/lib/audio/decoder";

interface LoadingStoreState {
  // Map pad keys to their loading states
  // Key format: "pad-{profileId}-{pageIndex}-{padIndex}"
  padLoadingStates: Map<string, LoadingState>;
  actions: {
    setPadLoadingState: (key: string, state: LoadingState | null) => void;
    clearPadLoadingState: (key: string) => void;
    clearAllLoadingStates: () => void;
  };
}

export const useLoadingStore = create<LoadingStoreState>((set) => ({
  padLoadingStates: new Map(),
  actions: {
    setPadLoadingState: (key, state) =>
      set((currentState) => {
        const newMap = new Map(currentState.padLoadingStates);
        if (state === null) {
          newMap.delete(key);
        } else {
          newMap.set(key, state);
        }
        return { padLoadingStates: newMap };
      }),

    clearPadLoadingState: (key) =>
      set((currentState) => {
        const newMap = new Map(currentState.padLoadingStates);
        if (newMap.delete(key)) {
          return { padLoadingStates: newMap };
        }
        return currentState; // Return original state if key wasn't found
      }),

    clearAllLoadingStates: () => set({ padLoadingStates: new Map() }),
  },
}));

// Export actions directly for easier usage outside of components
export const loadingStoreActions = useLoadingStore.getState().actions;

// Helper function to generate pad loading key
export function generatePadLoadingKey(
  profileId: number,
  pageIndex: number,
  padIndex: number,
): string {
  return `pad-${profileId}-${pageIndex}-${padIndex}`;
}

// Selector hook for a specific pad's loading state
export const usePadLoadingState = (
  profileId: number | null,
  pageIndex: number,
  padIndex: number,
) => {
  return useLoadingStore((state) => {
    if (profileId === null) return null;
    const key = generatePadLoadingKey(profileId, pageIndex, padIndex);
    return state.padLoadingStates.get(key) || null;
  });
};
