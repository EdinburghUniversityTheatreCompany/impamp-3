import { create } from "zustand";
import { PlaybackType } from "@/lib/db"; // Import PlaybackType for armed tracks
import { pinAudioBuffer, unpinAudioBuffer } from "@/lib/audio/cache";
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
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
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

/**
 * Queue an armed track's sounds for high-priority preloading.
 *
 * The audio module is imported lazily: it imports this store (playback.ts),
 * so a static import here would close the circle.
 */
function preloadArmedTrackSounds(trackInfo: ArmedTrackState): void {
  if (typeof window === "undefined") return;

  import("@/lib/audio")
    .then(({ preloadArmedTrack }) => {
      preloadArmedTrack(trackInfo.audioFileIds, {
        profileId: trackInfo.padInfo.profileId,
        pageIndex: trackInfo.padInfo.pageIndex,
        padIndex: trackInfo.padInfo.padIndex,
      });
    })
    .catch((error) => {
      console.error(
        `[PlaybackStore] Failed to preload armed track "${trackInfo.name}":`,
        error,
      );
    });
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
    //
    // Arming is a promise of an instant cue, so the sounds are pinned in the
    // audio cache (LRU eviction can't take them back) and queued for
    // preloading at the highest priority. Both are undone on disarm.
    armTrack: (key, trackInfo) => {
      // Re-arming the same pad: release the previous pins before taking new
      // ones, so the reference counts stay balanced
      const previous = get().armedTracks.get(key);
      if (previous) {
        previous.audioFileIds.forEach(unpinAudioBuffer);
      }
      trackInfo.audioFileIds.forEach(pinAudioBuffer);

      set((state) => {
        const newMap = new Map(state.armedTracks);
        newMap.set(key, trackInfo);
        return { armedTracks: newMap };
      });

      preloadArmedTrackSounds(trackInfo);
    },

    // Action to remove an armed track
    removeArmedTrack: (key) => {
      const removed = get().armedTracks.get(key);
      if (!removed) return; // Nothing armed under this key

      set((state) => {
        const newMap = new Map(state.armedTracks);
        newMap.delete(key);
        return { armedTracks: newMap };
      });

      // The cue is gone, so its sounds are ordinary cache entries again
      removed.audioFileIds.forEach(unpinAudioBuffer);
    },

    // Action to clear all armed tracks
    clearAllArmedTracks: () => {
      const armed = Array.from(get().armedTracks.values());
      set({ armedTracks: new Map() });
      armed.forEach((track) => track.audioFileIds.forEach(unpinAudioBuffer));
    },

    // Action to play the next armed track
    playNextArmedTrack: () => {
      const state = get();
      if (state.armedTracks.size === 0) return;

      // Get the first armed track (we'll use FIFO order)
      const firstKey = Array.from(state.armedTracks.keys())[0];
      const firstTrack = state.armedTracks.get(firstKey);

      if (firstTrack) {
        // Disarm synchronously so a rapid second trigger cannot fire the same cue
        get().actions.removeArmedTrack(firstKey);

        // Imported dynamically to avoid a circular dependency.
        import("@/lib/audio").then(({ triggerPad }) =>
          triggerPad(
            {
              padIndex: firstTrack.padInfo.padIndex,
              audioFileIds: firstTrack.audioFileIds,
              playbackType: firstTrack.playbackType,
              name: firstTrack.name,
              audioTrimSettings: firstTrack.audioTrimSettings,
              audioGainSettings: firstTrack.audioGainSettings,
              padGainDb: firstTrack.padGainDb,
            },
            {
              activeProfileId: firstTrack.padInfo.profileId,
              currentPageIndex: firstTrack.padInfo.pageIndex,
            },
            { logPrefix: "[PlaybackStore] armed track" },
          ),
        );
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

// Subscribes to a single pad's playback slice, so progress updates for one track
// only re-render that track's pad
export const usePadPlaybackState = (playbackKey: string | null) =>
  usePlaybackStore((state) =>
    playbackKey ? (state.activePlayback.get(playbackKey) ?? null) : null,
  );
