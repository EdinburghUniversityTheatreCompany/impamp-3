import { create } from "zustand";
import {
  PlaybackType,
  extractPadPlaybackSettings,
  getPadConfigurationsForProfileBank,
  type PadPlaybackSettings,
} from "@/lib/db";
import { pinAudioBuffer, unpinAudioBuffer } from "@/lib/audio/cache";
// import { ActiveTrack } from '@/lib/audio'; // Removed unused import

// Define the state structure for a single playing track in the store
export interface PlaybackState {
  key: string; // Unique playback key (e.g., `pad-${profileId}-${bankId}-${padIndex}`)
  name: string;
  progress: number; // 0.0 to 1.0
  remainingTime: number; // Seconds
  totalDuration: number; // Seconds
  isFading: boolean;
  padInfo: {
    profileId: number;
    bankId: string;
    padIndex: number;
  };
}

// Define the state structure for an armed track in the store
//
// An armed cue names a *pad*, not the sounds that pad happened to hold when it
// was armed. The playback fields below are a snapshot, kept for three jobs that
// all need an answer at arm time: pinning the buffers in the audio cache,
// queueing them for preload, and labelling the row in the Armed Tracks panel.
// They are deliberately *not* what gets played — see `playArmedTrackNow`.
export interface ArmedTrackState {
  key: string; // Unique armed track key (e.g., `armed-${profileId}-${bankId}-${padIndex}`)
  name: string;
  padInfo: {
    profileId: number;
    bankId: string;
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
    playArmedTrack: (key: string) => void;
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
        bankId: trackInfo.padInfo.bankId,
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

/**
 * Fire an armed cue from the pad's configuration as it stands *now*.
 *
 * `ArmedTrackState` carries a copy of the pad's sounds, trim and gain, and no
 * write path ever re-synced it: only the pad editor's "disabled" branch even
 * knew armed tracks existed. Editing a pad, swapping it, deleting its sound or
 * receiving a sync all left the cue pointing at the pre-edit definition, so
 * F9 played the sound the pad held minutes earlier, at the gain it had then —
 * and if the orphan cleanup had since removed that audio file, nothing at all.
 * Re-reading here makes the cue mean what the board shows, which is the only
 * reading a cue list can be driven from.
 *
 * The read is one keyed IndexedDB range query, and the armed sounds are pinned
 * and preloaded already, so it costs a tick rather than a decode.
 */
async function playArmedTrackNow(track: ArmedTrackState): Promise<void> {
  let pad: PadPlaybackSettings;
  try {
    const configs = await getPadConfigurationsForProfileBank(
      track.padInfo.profileId,
      track.padInfo.bankId,
    );
    // A pad with no row has no sound, which `extractPadPlaybackSettings({})`
    // states as an empty `audioFileIds` — the same answer as an emptied pad.
    pad = extractPadPlaybackSettings(
      configs.find((c) => c.padIndex === track.padInfo.padIndex) ?? {},
    );
  } catch (error) {
    // A database that is momentarily unreadable is a different failure from a
    // pad that has been emptied, and a cue is a deliberate act during a show.
    // Fall back to what was armed rather than swallowing the cue.
    console.warn(
      `[PlaybackStore] Could not re-read the pad behind armed track "${track.name}"; playing what was armed:`,
      error,
    );
    pad = extractPadPlaybackSettings(track);
  }

  if (pad.audioFileIds.length === 0) {
    console.warn(
      `[PlaybackStore] Armed track "${track.name}" no longer has a sound on pad ${track.padInfo.padIndex}; nothing to play.`,
    );
    return;
  }

  // Imported dynamically to avoid a circular dependency.
  const { triggerPad } = await import("@/lib/audio");
  await triggerPad(
    {
      ...pad,
      padIndex: track.padInfo.padIndex,
      // A renamed-to-nothing pad keeps the label the cue was armed under.
      name: pad.name ?? track.name,
    },
    {
      activeProfileId: track.padInfo.profileId,
      currentPageIndex: track.padInfo.bankId,
    },
    { logPrefix: "[PlaybackStore] armed track" },
  );
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

    // Action to play one named armed track.
    //
    // The queue is addressable because the Armed Tracks panel needs it to be:
    // every row's Play button called playNextArmedTrack(), so each one fired
    // the *head* of the queue while its own label said `Play ${name}`. With
    // more than one cue armed, pressing Play on the second row sent the first
    // cue to the room and left the intended one queued.
    playArmedTrack: (key) => {
      const track = get().armedTracks.get(key);
      if (!track) return;

      // Disarm synchronously so a rapid second trigger cannot fire the same cue
      get().actions.removeArmedTrack(key);

      void playArmedTrackNow(track).catch((error) => {
        console.error(
          `[PlaybackStore] Failed to play armed track "${track.name}":`,
          error,
        );
      });
    },

    // Action to play the next armed track — FIFO, which is what F9 means.
    playNextArmedTrack: () => {
      const firstKey = Array.from(get().armedTracks.keys())[0];
      if (firstKey === undefined) return;
      get().actions.playArmedTrack(firstKey);
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
