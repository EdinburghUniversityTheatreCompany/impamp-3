import { create } from "zustand";
// import { ActiveTrack } from '@/lib/audio'; // Removed unused import

// Define the state structure for a single playing track in the store
export interface PlaybackState {
  key: string; // Unique playback key (e.g., `pad-${profileId}-${pageIndex}-${padIndex}`)
  name: string;
  progress: number; // 0.0 to 1.0
  remainingTime: number; // Seconds
  totalDuration: number; // Seconds
  isFading: boolean;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
}

// Define the store's state and actions
interface PlaybackStoreState {
  activePlayback: Map<string, PlaybackState>; // Map playbackKey to its state
  actions: {
    setPlaybackState: (newState: Map<string, PlaybackState>) => void;
    addTrack: (key: string, initialState: PlaybackState) => void;
    removeTrack: (key: string) => void;
    updateTrackProgress: (
      key: string,
      progress: number,
      remainingTime: number,
    ) => void;
    setTrackFading: (key: string, isFading: boolean) => void;
    clearAllTracks: () => void;
  };
}

export const usePlaybackStore = create<PlaybackStoreState>((set) => ({
  // Removed unused 'get' parameter
  activePlayback: new Map(),
  actions: {
    // Action to completely replace the state (used by rAF loop)
    setPlaybackState: (newState) => set({ activePlayback: new Map(newState) }), // Create new map to ensure reactivity

    // Action to add a single track
    addTrack: (key, initialState) =>
      set((state) => {
        const newMap = new Map(state.activePlayback);
        newMap.set(key, initialState);
        return { activePlayback: newMap };
      }),

    // Action to remove a single track
    removeTrack: (key) =>
      set((state) => {
        const newMap = new Map(state.activePlayback);
        if (newMap.delete(key)) {
          return { activePlayback: newMap };
        }
        return state; // Return original state if key wasn't found
      }),

    // Action to update progress and remaining time for a track
    updateTrackProgress: (key, progress, remainingTime) =>
      set((state) => {
        const track = state.activePlayback.get(key);
        if (track) {
          const newMap = new Map(state.activePlayback);
          newMap.set(key, { ...track, progress, remainingTime });
          return { activePlayback: newMap };
        }
        return state;
      }),

    // Action to update the fading status of a track
    setTrackFading: (key, isFading) =>
      set((state) => {
        const track = state.activePlayback.get(key);
        if (track) {
          const newMap = new Map(state.activePlayback);
          newMap.set(key, { ...track, isFading });
          return { activePlayback: newMap };
        }
        return state;
      }),

    // Action to clear all tracks (e.g., on profile change)
    clearAllTracks: () => set({ activePlayback: new Map() }),
  },
}));

// Export actions directly for easier usage outside of components
export const playbackStoreActions = usePlaybackStore.getState().actions;

// Selector hook example (can add more specific ones as needed)
export const useActivePlayback = () =>
  usePlaybackStore((state) => state.activePlayback);
