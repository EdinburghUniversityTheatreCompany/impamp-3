import { create } from "zustand";
import { PlaybackType } from "@/lib/db"; // Import PlaybackType for armed tracks
import { LoadingState } from "@/lib/audio";
import {
  loadingStoreActions,
  generatePadLoadingKey,
} from "@/store/loadingStore";
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

// Define the state structure for an armed track in the store
export interface ArmedTrackState {
  key: string; // Unique armed track key (e.g., `armed-${profileId}-${pageIndex}-${padIndex}`)
  name: string;
  padInfo: {
    profileId: number;
    pageIndex: number;
    padIndex: number;
  };
  audioFileIds: number[];
  playbackType: PlaybackType;
}

// Define the store's state and actions
interface PlaybackStoreState {
  activePlayback: Map<string, PlaybackState>; // Map playbackKey to its state
  armedTracks: Map<string, ArmedTrackState>; // Map armedKey to its state
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

    // Armed tracks actions
    armTrack: (key: string, trackInfo: ArmedTrackState) => void;
    removeArmedTrack: (key: string) => void;
    clearAllArmedTracks: () => void;
    playNextArmedTrack: () => void;
  };
}

export const usePlaybackStore = create<PlaybackStoreState>((set, get) => ({
  activePlayback: new Map(),
  armedTracks: new Map(),
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

    // --- Armed Tracks Actions ---

    // Action to arm a track
    armTrack: (key, trackInfo) =>
      set((state) => {
        const newMap = new Map(state.armedTracks);
        newMap.set(key, trackInfo);
        return { armedTracks: newMap };
      }),

    // Action to remove an armed track
    removeArmedTrack: (key) =>
      set((state) => {
        const newMap = new Map(state.armedTracks);
        if (newMap.delete(key)) {
          return { armedTracks: newMap };
        }
        return state; // Return original state if key wasn't found
      }),

    // Action to clear all armed tracks
    clearAllArmedTracks: () => set({ armedTracks: new Map() }),

    // Action to play the next armed track
    playNextArmedTrack: () => {
      const state = get();
      if (state.armedTracks.size === 0) return;

      // Get the first armed track (we'll use FIFO order)
      const firstKey = Array.from(state.armedTracks.keys())[0];
      const firstTrack = state.armedTracks.get(firstKey);

      if (firstTrack) {
        // Import triggerAudioForPadInstant dynamically to avoid circular dependencies
        import("@/lib/audio").then(({ triggerAudioForPadInstant }) => {
          // Play the armed track with instant response
          triggerAudioForPadInstant({
            padIndex: firstTrack.padInfo.padIndex,
            audioFileIds: firstTrack.audioFileIds,
            playbackType: firstTrack.playbackType,
            activeProfileId: firstTrack.padInfo.profileId,
            currentPageIndex: firstTrack.padInfo.pageIndex,
            name: firstTrack.name,
            onInstantFeedback: () => {
              console.log(
                `[PlaybackStore] Armed track triggered: "${firstTrack.name}"`,
              );
            },
            onLoadingStateChange: (state: LoadingState) => {
              console.log(
                `[PlaybackStore] Armed track loading: ${state.status} ${Math.round((state.progress || 0) * 100)}%`,
              );
              const loadingKey = generatePadLoadingKey(
                firstTrack.padInfo.profileId,
                firstTrack.padInfo.pageIndex,
                firstTrack.padInfo.padIndex,
              );
              loadingStoreActions.setPadLoadingState(loadingKey, state);
            },
            onAudioReady: () => {
              console.log(
                `[PlaybackStore] Armed track ready: "${firstTrack.name}"`,
              );
              const loadingKey = generatePadLoadingKey(
                firstTrack.padInfo.profileId,
                firstTrack.padInfo.pageIndex,
                firstTrack.padInfo.padIndex,
              );
              loadingStoreActions.clearPadLoadingState(loadingKey);
            },
            onError: (error) => {
              console.error(
                `[PlaybackStore] Armed track error for "${firstTrack.name}":`,
                error,
              );
              const loadingKey = generatePadLoadingKey(
                firstTrack.padInfo.profileId,
                firstTrack.padInfo.pageIndex,
                firstTrack.padInfo.padIndex,
              );
              loadingStoreActions.clearPadLoadingState(loadingKey);
            },
          });

          // Remove from armed tracks
          get().actions.removeArmedTrack(firstKey);
        });
      }
    },
  },
}));

// Export actions directly for easier usage outside of components
export const playbackStoreActions = usePlaybackStore.getState().actions;

// Selector hooks
export const useActivePlayback = () =>
  usePlaybackStore((state) => state.activePlayback);

export const useArmedTracks = () =>
  usePlaybackStore((state) => state.armedTracks);
