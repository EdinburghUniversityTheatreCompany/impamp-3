/**
 * Audio Module - Core Playback
 *
 * Handles the creation and management of audio playback sources.
 * Provides functions for playing, stopping, and fading audio.
 *
 * @module lib/audio/playback
 */

import { getAudioContext } from "./context";
import {
  ActiveTrack,
  MAX_LAYERS_PER_PAD,
  PlayAudioParams,
  TrackSource,
  baseKeyOf,
  layerIndexOf,
  makeInstanceKey,
} from "./types";
import { playbackStoreActions } from "@/store/playbackStore";
import { exposeE2EHook } from "@/lib/testHooks";
import { MAX_GAIN } from "./loudness/constants";

/**
 * Clamps a resolved gain for the gain node.
 *
 * The ceiling used to be 1, which meant normalisation could attenuate a loud
 * file but never raise a quiet one. A non-finite value falls back to unity so
 * a bad measurement mutes nothing.
 */
export function clampPlaybackGain(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(MAX_GAIN, volume));
}

// Track all currently active audio tracks
const activeTracks = new Map<string, ActiveTrack>();

// The live instance keys of each pad, in registration order — the order a
// layer actually started sounding, not the order its trigger was allocated a
// number. Under an async load path those can differ (a later trigger can
// finish loading first), and registration order is the right one for the cap
// below to evict by: "oldest" means the layer that has been audible longest,
// not the layer whose number is smallest.
//
// A pad that never layers holds exactly one entry, and that entry is its bare
// base key, so the single-instance path keeps the shape it always had. Written
// only by `claimPlaybackKey` and `clearTrackState`, which are the only two
// places a track enters and leaves `activeTracks`, so the two cannot drift.
const layersByBase = new Map<string, string[]>();

// The next layer number for a pad. It grows and is never reused, so a timer or
// an `onended` handler left over from a stopped layer can never address the
// layer that replaced it. The *entry* is never pruned either, even once a pad
// has no live layers at all — deleting it on empty would let the very next
// trigger reuse a number a still-in-flight timer from the previous session
// might reference. Bounded by the number of distinct pads a session ever
// plays, same as `keyStopGenerations` below.
const nextLayerIndex = new Map<string, number>();

function registerInstance(instanceKey: string): void {
  const base = baseKeyOf(instanceKey);
  const keys = layersByBase.get(base) ?? [];
  if (!keys.includes(instanceKey)) keys.push(instanceKey);
  layersByBase.set(base, keys);
}

function forgetInstance(instanceKey: string): void {
  const base = baseKeyOf(instanceKey);
  const keys = layersByBase.get(base);
  if (!keys) return;
  const at = keys.indexOf(instanceKey);
  if (at !== -1) keys.splice(at, 1);
  if (keys.length === 0) layersByBase.delete(base);
}

/**
 * The live instances of one pad, oldest first.
 *
 * @param baseKey - A base key or any instance key of the pad
 * @returns A copy of the instance keys, safe to iterate while they are stopped
 */
export function getLayerKeys(baseKey: string): string[] {
  return [...(layersByBase.get(baseKeyOf(baseKey)) ?? [])];
}

/**
 * Takes the next instance key for a pad, and makes room for it.
 *
 * At the cap the oldest layer stops first, so a trigger always makes a sound
 * rather than being refused.
 *
 * @param playbackKey - The pad's own playback key, or any instance key of it
 * @returns The instance key the new layer must play under
 */
export function allocateLayerKey(playbackKey: string): string {
  // Every sibling here accepts a base key or any instance key of the pad; an
  // un-normalised key would let a caller that passes an instance key (say,
  // one it already holds from a previous layer) mint a key like
  // "pad-1#3#1" — registered under the phantom base "pad-1#3", which
  // `stopTrack("pad-1")` and the Active Tracks row can never reach.
  const base = baseKeyOf(playbackKey);

  const live = getLayerKeys(base);
  if (live.length >= MAX_LAYERS_PER_PAD) {
    stopInstance(live[0]);
  }
  const index = nextLayerIndex.get(base) ?? 1;
  nextLayerIndex.set(base, index + 1);
  return makeInstanceKey(base, index);
}

// Incremented whenever *everything* is stopped (the panic button), so an
// in-flight trigger for any pad is cancelled.
let globalStopGeneration = 0;

// Incremented per playback key when that key alone is stopped.
//
// This used to be one global counter, which meant stopping pad B cancelled
// pad A's still-loading trigger — with `activePadBehavior` set to "stop" or
// "restart", simply retriggering one pad silently swallowed another's. Keyed
// so a stop only speaks for the pad it stopped. Bounded by the number of pads
// stopped in a session, and entries must outlive their track: the whole point
// is that a trigger which has not registered anything yet can still see that
// its pad was stopped.
const keyStopGenerations = new Map<string, number>();

// Duration of the de-click ramp applied when hard stopping a track
const HARD_STOP_FADE_SECONDS = 0.02;

// rAF loop ID
let rAFId: number | null = null;

// Previous playback state for change detection
const previousPlaybackState = new Map<
  string,
  {
    progress: number;
    remainingTime: number;
    isFading: boolean;
  }
>();

// Media elements whose object URL has already been revoked. Keyed by the
// element (weakly held) so disposal is idempotent and a blob URL is never
// revoked twice — nor left dangling.
const disposedMediaElements = new WeakSet<HTMLAudioElement>();

// Reusable objects to reduce garbage collection pressure

/**
 * Creates an audio source node for playback
 *
 * @param buffer - The audio buffer to play
 * @param volume - The volume level (0.0 to MAX_GAIN)
 * @returns Object containing source node and gain node
 */
function createAudioSource(
  buffer: AudioBuffer,
  volume: number = 1.0,
): { source: AudioBufferSourceNode; gainNode: GainNode } {
  const context = getAudioContext();

  // Create source node and assign buffer
  const source = context.createBufferSource();
  source.buffer = buffer;

  // Create gain node for volume control and fading
  const gainNode = context.createGain();
  gainNode.gain.setValueAtTime(clampPlaybackGain(volume), context.currentTime);

  // Connect nodes together
  source.connect(gainNode);
  gainNode.connect(context.destination);

  return { source, gainNode };
}

/**
 * Normalises a requested trim range against the media's real duration.
 *
 * Invalid values (NaN, negative, reversed or out-of-range) fall back to
 * playing the whole file rather than producing a zero-length or negative
 * playback window.
 *
 * @param rawStart - Requested trim start in seconds
 * @param rawEnd - Requested trim end in seconds (undefined = play to the end)
 * @param duration - Known media duration, if available
 * @returns The clamped trim range; trimEnd stays undefined when unknown/invalid
 */
export function clampTrimRange(
  rawStart: number | undefined,
  rawEnd: number | undefined,
  duration?: number,
): { trimStart: number; trimEnd: number | undefined } {
  const hasDuration =
    duration !== undefined && Number.isFinite(duration) && duration > 0;

  let trimStart = rawStart ?? 0;
  if (!Number.isFinite(trimStart) || trimStart < 0) {
    trimStart = 0;
  }
  if (hasDuration) {
    trimStart = Math.min(trimStart, duration as number);
  }

  let trimEnd = rawEnd;
  if (trimEnd !== undefined) {
    if (
      !Number.isFinite(trimEnd) ||
      trimEnd <= trimStart ||
      (hasDuration && trimEnd > (duration as number))
    ) {
      // Unusable end point — fall back to the natural end of the media
      trimEnd = undefined;
    }
  }

  // A start at/past the end with no usable end point would yield an empty
  // window; play the whole file instead.
  if (
    trimEnd === undefined &&
    hasDuration &&
    trimStart >= (duration as number)
  ) {
    trimStart = 0;
  }

  return { trimStart, trimEnd };
}

/**
 * A snapshot of both stop counters that apply to one playback key.
 *
 * Two are needed because a stop can be aimed at one pad (`stopTrack`) or at
 * everything (`stopAllTracks`), and a pending trigger must notice the second
 * without being cancelled by every instance of the first.
 */
export interface StopGeneration {
  readonly global: number;
  readonly key: number;
}

/**
 * Captures the stop counters for a playback key.
 *
 * Callers that await asynchronous work before starting playback capture this
 * before the first await and pass it to {@link stopRequestedSince} afterwards.
 *
 * @param playbackKey - The key the caller intends to play on
 * @returns The counters as they stand now
 */
export function getStopGeneration(playbackKey: string): StopGeneration {
  return {
    global: globalStopGeneration,
    // Per pad, not per layer: a stop aimed at the pad must reach a trigger for
    // any of its layers that has not registered a track yet.
    key: keyStopGenerations.get(baseKeyOf(playbackKey)) ?? 0,
  };
}

/**
 * Whether a stop that this playback key should honour happened since the
 * counters were captured — either its own pad was stopped, or everything was.
 *
 * @param playbackKey - The key the caller intends to play on
 * @param captured - The value {@link getStopGeneration} returned earlier
 * @returns True if the pending trigger should abandon itself
 */
export function stopRequestedSince(
  playbackKey: string,
  captured: StopGeneration,
): boolean {
  const now = getStopGeneration(playbackKey);
  return now.global !== captured.global || now.key !== captured.key;
}

/**
 * Halts playback of a track's underlying source.
 * May throw InvalidStateError for buffer sources that already stopped.
 */
function stopSourcePlayback(source: TrackSource): void {
  if (source.kind === "buffer") {
    source.sourceNode.stop(0);
  } else {
    source.element.onended = null;
    source.element.pause();
  }
}

/**
 * Releases the resources held by a media element source: detaches the
 * element and revokes the object URL so the underlying blob can be
 * garbage collected. Idempotent — the object URL is revoked exactly once.
 */
function disposeMediaSource(source: Extract<TrackSource, { kind: "media" }>) {
  const { element, sourceNode, objectUrl } = source;

  if (disposedMediaElements.has(element)) {
    return;
  }
  disposedMediaElements.add(element);

  element.onended = null;
  element.onerror = null;
  if (!element.paused) {
    element.pause();
  }
  try {
    sourceNode.disconnect();
  } catch {
    // Ignore — node may already be disconnected
  }
  element.removeAttribute("src");
  element.load(); // Release network/decoder resources held by the element
  URL.revokeObjectURL(objectUrl);
}

/**
 * Releases a track source's resources without touching the active track
 * state. Used when a source outlives its slot in the track map (e.g. a
 * faded-out source whose playback key has been taken over by a restart).
 */
function disposeTrackSource(source: TrackSource): void {
  if (source.kind === "media") {
    disposeMediaSource(source);
  } else {
    try {
      stopSourcePlayback(source);
    } catch {
      // Ignore — source may already have stopped
    }
  }
}

/**
 * Forgets a streamed track's scheduled trim-end cut.
 *
 * Anything that ends a track early — a stop, a fade, the rAF backstop getting
 * there first — takes the cut over, and a timer that outlives its track would
 * otherwise fire against a pad that has since been retriggered.
 */
function cancelScheduledTrimEnd(track: ActiveTrack): void {
  if (track.trimEndTimer !== undefined) {
    clearTimeout(track.trimEndTimer);
    track.trimEndTimer = undefined;
  }
}

/**
 * Schedules the end of a streamed track's trim window on the audio clock.
 *
 * Buffer playback gets this for free: `source.start(when, offset, duration)`
 * is honoured by the audio thread whatever the main thread is doing. A media
 * element has no equivalent, and the end point used to be policed only from
 * `playbackLoopTick` — which `requestAnimationFrame` schedules, and which a
 * browser stops calling in a hidden tab. Since `context.ts` deliberately keeps
 * audio running when the tab is hidden, switching windows mid-cue played the
 * whole file: the untrimmed tail, which is normally the part that was trimmed
 * off precisely because it should never go to air.
 *
 * Two mechanisms, because neither is sufficient alone. The gain ramp is what
 * is *heard*: it is scheduled on the audio thread, so it is sample-accurate
 * and immune to throttling. The timer is only bookkeeping — releasing the
 * element and clearing the UI state — and a hidden tab may run it as much as a
 * second late, by which time the track has been silent for a second anyway.
 *
 * Called whenever the real playback position becomes known or changes, and
 * replaces any previous schedule rather than adding to it.
 *
 * @param playbackKey - The key the track holds
 * @param track - The streamed track to cut
 */
function scheduleStreamingTrimEnd(
  playbackKey: string,
  track: ActiveTrack,
): void {
  cancelScheduledTrimEnd(track);

  if (track.source.kind !== "media" || track.trimEnd === undefined) return;
  // A fade has already taken over the level and the ending; leave it alone.
  if (track.isFading) return;

  const element = track.source.element;
  const secondsLeft = track.trimEnd - element.currentTime;
  if (!Number.isFinite(secondsLeft)) return;

  const remaining = Math.max(0, secondsLeft);

  try {
    const context = getAudioContext();
    const gain = track.gainNode.gain;
    const cutAt = context.currentTime + remaining;
    const rampFrom = Math.max(
      context.currentTime,
      cutAt - HARD_STOP_FADE_SECONDS,
    );
    const level = gain.value;

    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(level, context.currentTime);
    gain.setValueAtTime(level, rampFrom);
    gain.linearRampToValueAtTime(0, cutAt);
  } catch (error) {
    // A level that could not be scheduled still has to end; the timer below
    // is the part that guarantees it does.
    console.warn(
      `[Audio Playback] Could not schedule the trim-end ramp for key ${playbackKey}:`,
      error,
    );
  }

  track.trimEndTimer = setTimeout(() => {
    track.trimEndTimer = undefined;
    console.log(
      `[Audio Playback] Streaming playback reached trim end for key: ${playbackKey}`,
    );
    cleanupTrackIfCurrent(playbackKey, track);
  }, remaining * 1000);
}

/**
 * Removes all bookkeeping for a track and stops the monitoring loop if idle.
 *
 * Does not touch the underlying source — callers decide whether the source
 * is released immediately or after a de-click ramp.
 *
 * @param playbackKey - The unique key for the playback
 */
function clearTrackState(playbackKey: string): void {
  forgetInstance(playbackKey);
  activeTracks.delete(playbackKey);
  previousPlaybackState.delete(playbackKey); // Clean up change detection state
  playbackStoreActions.removeTrack(playbackKey);
  stopPlaybackLoopIfIdle();
}

/**
 * Removes a track and releases all resources associated with it.
 */
function cleanupTrack(playbackKey: string): void {
  const track = activeTracks.get(playbackKey);

  if (track) {
    cancelScheduledTrimEnd(track);
    if (track.source.kind === "media") {
      disposeMediaSource(track.source);
    }
  }

  clearTrackState(playbackKey);
}

/**
 * Cleans up a track only if it still owns its playback key. When another
 * track has taken over the key (e.g. "restart" behavior replaced it while
 * a fade-out was still pending), only the stale source's resources are
 * released and the new track's state is left untouched.
 */
function cleanupTrackIfCurrent(playbackKey: string, track: ActiveTrack): void {
  cancelScheduledTrimEnd(track);

  if (activeTracks.get(playbackKey) === track) {
    cleanupTrack(playbackKey);
  } else {
    disposeTrackSource(track.source);
  }
}

/**
 * Registers a track against its playback key, silencing whatever held the key.
 *
 * The occupancy check is the point. Two triggers for one pad can both get past
 * `isTrackPlaying` while their audio is still loading, and the second used to
 * overwrite the first in the map without stopping it — leaving it audible and,
 * because `stopAllTracks` iterates the map, beyond the reach of the panic
 * button. Displacement is not expected in normal use; it means two triggers
 * raced, so it is worth a warning.
 *
 * @param playbackKey - The key being claimed
 * @param track - The track claiming it
 */
function claimPlaybackKey(playbackKey: string, track: ActiveTrack): void {
  const displaced = activeTracks.get(playbackKey);

  if (displaced && displaced !== track) {
    console.warn(
      `[Audio Playback] A second trigger displaced a live track on key: ${playbackKey}. Silencing the one it replaced.`,
    );
    disposeTrackSource(displaced.source);
  }

  activeTracks.set(playbackKey, track);
  registerInstance(playbackKey);
}

/**
 * Plays an audio buffer with the specified parameters
 *
 * @param buffer - The audio buffer to play
 * @param playbackKey - Unique identifier for this playback instance
 * @param params - Configuration for playback
 * @returns The created audio source node or null if playback failed
 */
export function playBuffer(
  buffer: AudioBuffer,
  playbackKey: string,
  params: PlayAudioParams,
): AudioBufferSourceNode | null {
  try {
    const context = getAudioContext();
    const volume = params.volume ?? 1.0;

    console.log(`[Audio Playback] Starting playback for key: ${playbackKey}`);

    // Create audio source
    const { source, gainNode } = createAudioSource(buffer, volume);

    // Apply trim settings, falling back to the full buffer when invalid
    const clamped = clampTrimRange(
      params.trimStart,
      params.trimEnd,
      buffer.duration,
    );
    const trimStart = clamped.trimStart;
    const trimEnd = clamped.trimEnd ?? buffer.duration;
    const trimmedDuration = trimEnd - trimStart;

    // Start playback with trim offset and duration
    source.start(0, trimStart, trimmedDuration);

    // Store track information
    const track: ActiveTrack = {
      source: { kind: "buffer", sourceNode: source },
      gainNode,
      name: params.name,
      startTime: context.currentTime,
      duration: trimmedDuration,
      trimStart,
      trimEnd,
      padInfo: params.padInfo,
      isFading: false,
      // Include multi-sound state
      playbackType: params.multiSoundState.playbackType,
      allAudioFileIds: params.multiSoundState.allAudioFileIds,
      currentAudioFileId: params.multiSoundState.currentAudioFileId,
      currentAudioIndex: params.multiSoundState.currentAudioIndex,
      availableAudioIndices: params.multiSoundState.availableAudioIndices,
    };

    // Set up onended handler for cleanup. Guarded by track identity so a
    // source that was replaced (e.g. via "restart" behavior) can't remove
    // its successor's state when it finishes.
    source.onended = () => {
      console.log(
        `[Audio Playback] Playback naturally finished for key: ${playbackKey}`,
      );
      cleanupTrackIfCurrent(playbackKey, track);
    };

    claimPlaybackKey(playbackKey, track);

    // Add to playback store (UI state)
    const initialState = {
      key: playbackKey,
      name: params.name,
      progress: 0,
      remainingTime: trimmedDuration,
      totalDuration: trimmedDuration,
      isFading: false,
      padInfo: params.padInfo,
    };

    playbackStoreActions.addTrack(playbackKey, initialState);

    // Start the rAF loop if it's not already running
    startPlaybackLoop();

    console.log(
      `[Audio Playback] Successfully started playback for key: ${playbackKey}`,
    );
    return source;
  } catch (error) {
    console.error(
      `[Audio Playback] Error playing audio for key ${playbackKey}:`,
      error,
    );
    return null;
  }
}

/**
 * Plays an audio blob by streaming it through an HTMLAudioElement.
 *
 * Playback starts as soon as the browser has decoded the first chunks
 * (typically tens of milliseconds) without decoding the whole file into
 * an AudioBuffer, so no PCM memory is held. The element is routed through
 * the Web Audio graph so fades and stop-all behave exactly like buffer
 * playback.
 *
 * @param blob - The stored audio file blob to stream
 * @param playbackKey - Unique identifier for this playback instance
 * @param params - Configuration for playback
 * @returns The created media element or null if playback failed
 */
export function playBlobStreaming(
  blob: Blob,
  playbackKey: string,
  params: PlayAudioParams,
): HTMLAudioElement | null {
  let objectUrl: string | null = null;

  try {
    const context = getAudioContext();
    const volume = params.volume ?? 1.0;

    console.log(
      `[Audio Playback] Starting streaming playback for key: ${playbackKey}`,
    );

    objectUrl = URL.createObjectURL(blob);
    const element = new Audio();
    element.preload = "auto";
    element.src = objectUrl;

    // Route the element through the Web Audio graph so existing gain/fade
    // logic applies to streamed tracks too
    const sourceNode = context.createMediaElementSource(element);
    const gainNode = context.createGain();
    gainNode.gain.setValueAtTime(
      clampPlaybackGain(volume),
      context.currentTime,
    );
    sourceNode.connect(gainNode);
    gainNode.connect(context.destination);

    // The full duration may be unknown until metadata loads; the playback
    // monitoring loop fills it in from element.duration once available
    const elementDuration =
      isFinite(element.duration) && element.duration > 0
        ? element.duration
        : undefined;

    // Clamp the requested trim range; with no duration yet only the obvious
    // invariants can be enforced, the rest is re-checked on loadedmetadata
    const { trimStart, trimEnd } = clampTrimRange(
      params.trimStart,
      params.trimEnd,
      elementDuration,
    );

    if (trimStart > 0) {
      try {
        // May be ignored/throw before metadata is available; re-applied by
        // the loadedmetadata handler below in that case
        element.currentTime = trimStart;
      } catch {
        // Ignore — seek is retried once metadata loads
      }
    }

    const knownDuration =
      trimEnd !== undefined
        ? trimEnd - trimStart
        : elementDuration !== undefined
          ? elementDuration - trimStart
          : 0;

    const track: ActiveTrack = {
      source: { kind: "media", element, sourceNode, objectUrl },
      gainNode,
      name: params.name,
      startTime: context.currentTime,
      duration: knownDuration,
      trimStart,
      trimEnd,
      padInfo: params.padInfo,
      isFading: false,
      // Include multi-sound state
      playbackType: params.multiSoundState.playbackType,
      allAudioFileIds: params.multiSoundState.allAudioFileIds,
      currentAudioFileId: params.multiSoundState.currentAudioFileId,
      currentAudioIndex: params.multiSoundState.currentAudioIndex,
      availableAudioIndices: params.multiSoundState.availableAudioIndices,
    };

    // Once the real duration is known, re-clamp the trim range against it
    // and apply the start seek if it couldn't be applied earlier
    element.addEventListener(
      "loadedmetadata",
      () => {
        const duration = element.duration;
        if (!isFinite(duration) || duration <= 0) return;

        const reclamped = clampTrimRange(
          track.trimStart,
          track.trimEnd,
          duration,
        );
        track.trimStart = reclamped.trimStart;
        track.trimEnd = reclamped.trimEnd;

        if (track.duration <= 0) {
          track.duration = (track.trimEnd ?? duration) - track.trimStart;
        }

        if (track.trimStart > 0 && element.currentTime < track.trimStart) {
          try {
            element.currentTime = track.trimStart;
          } catch {
            // Ignore — playback simply starts from the beginning
          }
        }

        scheduleStreamingTrimEnd(playbackKey, track);
      },
      { once: true },
    );

    // Rescheduled once playback is genuinely under way, because that is when
    // the deadline and the playback position first agree: `play()` resolves
    // asynchronously, so a cut measured at `loadedmetadata` starts its
    // wall-clock countdown slightly before the audio does. Not `once` — a
    // resume after any pause has to move the deadline with it.
    element.addEventListener("playing", () => {
      scheduleStreamingTrimEnd(playbackKey, track);
    });

    // Handlers are guarded by track identity so a source that was replaced
    // (e.g. via "restart" behavior) can't remove its successor's state
    element.onended = () => {
      console.log(
        `[Audio Playback] Streaming playback naturally finished for key: ${playbackKey}`,
      );
      cleanupTrackIfCurrent(playbackKey, track);
    };
    element.onerror = () => {
      console.error(
        `[Audio Playback] Media element error during streaming playback for key: ${playbackKey}`,
        element.error,
      );
      cleanupTrackIfCurrent(playbackKey, track);
    };

    element.play().catch((error) => {
      console.error(
        `[Audio Playback] Streaming play() failed for key ${playbackKey}:`,
        error,
      );
      cleanupTrackIfCurrent(playbackKey, track);
    });

    claimPlaybackKey(playbackKey, track);

    // Add to playback store (UI state)
    playbackStoreActions.addTrack(playbackKey, {
      key: playbackKey,
      name: params.name,
      progress: 0,
      remainingTime: knownDuration,
      totalDuration: knownDuration,
      isFading: false,
      padInfo: params.padInfo,
    });

    // Start the rAF loop if it's not already running
    startPlaybackLoop();

    console.log(
      `[Audio Playback] Successfully started streaming playback for key: ${playbackKey}`,
    );
    return element;
  } catch (error) {
    console.error(
      `[Audio Playback] Error streaming audio for key ${playbackKey}:`,
      error,
    );
    // The track never became active, so nothing else will revoke this URL
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }
    return null;
  }
}

/**
 * Waits until a streaming media element is actually able to play (or has
 * failed). Lets callers fall back to the decode path for files the media
 * pipeline can't handle. Resolves quickly — blob-backed sources reach
 * "canplay" within milliseconds.
 *
 * @param element - The media element returned by playBlobStreaming
 * @returns Promise resolving to true if playable, false on media error
 */
export function waitForStreamingPlayable(
  element: HTMLAudioElement,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (element.error) {
      resolve(false);
      return;
    }
    if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      resolve(true);
      return;
    }

    let timeoutId = 0;
    const cleanup = () => {
      element.removeEventListener("canplay", onReady);
      element.removeEventListener("playing", onReady);
      element.removeEventListener("error", onError);
      // "emptied" fires when the element is reset/disposed before it ever
      // became playable (e.g. a rejected play() triggered cleanup)
      element.removeEventListener("emptied", onError);
      element.removeEventListener("abort", onError);
      clearTimeout(timeoutId);
    };
    const onReady = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(false);
    };

    element.addEventListener("canplay", onReady);
    element.addEventListener("playing", onReady);
    element.addEventListener("error", onError);
    element.addEventListener("emptied", onError);
    element.addEventListener("abort", onError);

    // Safety net — blob-backed sources normally settle within milliseconds
    timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA);
    }, 4000);
  });
}

/**
 * Whether any instance of a pad plays now.
 *
 * Takes a base key or an instance key, so `controls.ts`'s retrigger decision
 * needs no change: it asks about the pad, and any live layer answers yes.
 */
export function isTrackPlaying(playbackKey: string): boolean {
  return (layersByBase.get(baseKeyOf(playbackKey))?.length ?? 0) > 0;
}

/**
 * Whether a pad is entirely on its way out.
 *
 * True only when every live instance fades. A pad with one fading layer and one
 * at full level is still playing, and a new trigger must treat it that way —
 * for a pad with a single track this is the exact answer it gave before.
 */
export function isTrackFading(playbackKey: string): boolean {
  const keys = layersByBase.get(baseKeyOf(playbackKey));
  if (!keys || keys.length === 0) return false;
  return keys.every((key) => activeTracks.get(key)?.isFading === true);
}

/**
 * Gets all currently active playback keys
 *
 * @returns Array of active playback keys
 */
export function getActivePlaybackKeys(): string[] {
  return Array.from(activeTracks.keys());
}

/**
 * The track behind a key.
 *
 * An instance key answers with its own track, which is what the streaming path
 * needs to check that it still owns the element it started. A base key answers
 * with the newest layer, which is what the pad ring follows.
 *
 * The two cases are told apart by the *shape* of the key
 * (`baseKeyOf(key) === key` iff it carries no layer suffix), not by whether
 * `activeTracks` happens to have a direct entry for it: a pad's very first,
 * un-layered instance is registered under its bare base key, so a presence
 * check alone would answer with that instance forever and never see a newer
 * layer take over.
 */
export function getActiveTrack(playbackKey: string): ActiveTrack | null {
  const base = baseKeyOf(playbackKey);
  if (playbackKey !== base) {
    // An instance key always names its own track directly.
    return activeTracks.get(playbackKey) ?? null;
  }
  const keys = layersByBase.get(base);
  if (!keys || keys.length === 0) return null;
  return activeTracks.get(keys[keys.length - 1]) ?? null;
}

// Which sound a multi-sound pad picked is invisible in the UI — the Active
// Tracks panel shows the pad's name, not the selected file's — so the playback
// mode tests read the selection through this hook. See lib/testHooks.
exposeE2EHook("__impampActiveSounds", () =>
  Array.from(activeTracks.entries()).map(([key, track]) => ({
    key,
    baseKey: baseKeyOf(key),
    layerIndex: layerIndexOf(key),
    name: track.name,
    // Which pipeline is playing is invisible in the UI too, and the trim end
    // is enforced completely differently by each: natively for a buffer,
    // scheduled for a media element. A test about the second has to be able
    // to prove it got the second.
    sourceKind: track.source.kind,
    playbackType: track.playbackType,
    currentAudioFileId: track.currentAudioFileId,
    currentAudioIndex: track.currentAudioIndex,
    allAudioFileIds: track.allAudioFileIds,
  })),
);

/**
 * Initiates a fade-out for one instance
 *
 * @param playbackKey - The unique key for the playback
 * @param durationInSeconds - Duration of the fade-out in seconds
 * @returns True if fade-out was initiated successfully
 */
export function fadeOutInstance(
  playbackKey: string,
  durationInSeconds: number,
): boolean {
  const track = activeTracks.get(playbackKey);

  // If track doesn't exist or is already fading, do nothing
  if (!track || track.isFading) return false;

  // The fade owns the level and the ending from here; a scheduled trim-end
  // ramp would fight it for the same gain node.
  cancelScheduledTrimEnd(track);

  try {
    const context = getAudioContext();
    const source = track.source;
    const gain = track.gainNode.gain;

    // Fade the track's own gain node from its current level down to silence.
    // The graph is left untouched, so the fade applies to both buffer and
    // media element sources and starts from the real current volume.
    const currentGain = gain.value;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(currentGain, context.currentTime);
    gain.linearRampToValueAtTime(0, context.currentTime + durationInSeconds);

    // Mark track as fading
    track.isFading = true;
    playbackStoreActions.setTrackFading(playbackKey, true);

    console.log(
      `[Audio Playback] Starting ${durationInSeconds}s fade for key: ${playbackKey}`,
    );

    // Clean up after the fade completes
    setTimeout(() => {
      // Always halt the faded source, even if the key now holds another track
      try {
        stopSourcePlayback(source);
      } catch (error) {
        // Ignore errors if already stopped (e.g., due to natural end)
        if ((error as DOMException).name !== "InvalidStateError") {
          console.warn(
            `[Audio Playback] Error stopping source during fade cleanup for key ${playbackKey}:`,
            error,
          );
        }
      }

      // Only remove state if the track is still the one we started fading
      if (activeTracks.get(playbackKey) === track) {
        cleanupTrack(playbackKey);
        console.log(`[Audio Playback] Fade completed for key: ${playbackKey}`);
      } else {
        console.log(
          `[Audio Playback] Fade cleanup skipped for key ${playbackKey} as track changed or was removed.`,
        );
        // Still release the faded source's resources — it no longer owns
        // the playback key but may be playing silently
        disposeTrackSource(source);
      }
    }, durationInSeconds * 1000);

    return true;
  } catch (error) {
    console.error(
      `[Audio Playback] Error initiating ${durationInSeconds}s fade for key ${playbackKey}:`,
      error,
    );

    // Fallback: If fade setup fails, attempt immediate stop and cleanup
    console.warn(
      `[Audio Playback] Fade initiation failed for key ${playbackKey}. Attempting fallback immediate stop.`,
    );
    try {
      stopSourcePlayback(track.source);
    } catch (stopError) {
      console.error(
        `[Audio Playback] Error during fallback stop for key ${playbackKey}:`,
        stopError,
      );
    }
    // State must be released even when the source refused to stop
    cleanupTrack(playbackKey);

    return false;
  }
}

/**
 * Fades out every layer of a pad over the same duration.
 *
 * @param baseKey - The pad's own playback key, or any instance key of it
 * @param durationInSeconds - Length of the fade
 * @returns True if at least one instance started a fade
 */
export function fadeOutTrack(
  baseKey: string,
  durationInSeconds: number,
): boolean {
  let faded = false;
  for (const instanceKey of getLayerKeys(baseKey)) {
    if (fadeOutInstance(instanceKey, durationInSeconds)) faded = true;
  }
  return faded;
}

/**
 * Stops one layer immediately, and cancels any fade on it.
 *
 * Deliberately leaves the pad's stop generation alone: stopping one layer must
 * not cancel a trigger that is still loading a different layer of the same pad.
 *
 * @param instanceKey - The exact instance to stop
 * @returns True if there was an instance to stop
 */
export function stopInstance(instanceKey: string): boolean {
  console.log(`[Audio Playback] Requesting stop for instance: ${instanceKey}`);

  const track = activeTracks.get(instanceKey);
  if (!track) return false;

  cancelScheduledTrimEnd(track);

  const source = track.source;

  try {
    const context = getAudioContext();
    const gain = track.gainNode.gain;
    const stopAt = context.currentTime + HARD_STOP_FADE_SECONDS;

    // Override any scheduled automation (e.g. an in-progress fade) with a
    // very short ramp to silence to avoid clicks
    const currentGain = gain.value;
    gain.cancelScheduledValues(context.currentTime);
    gain.setValueAtTime(currentGain, context.currentTime);
    gain.linearRampToValueAtTime(0, stopAt);

    if (source.kind === "buffer") {
      source.sourceNode.stop(stopAt);
    } else {
      // Media elements can't schedule a pause, so detach the handlers now
      // (the track is gone as far as the app is concerned) and release the
      // element once the de-click ramp has run to silence.
      source.element.onended = null;
      source.element.onerror = null;
      setTimeout(
        () => disposeMediaSource(source),
        HARD_STOP_FADE_SECONDS * 1000,
      );
    }
  } catch (error) {
    // Ignore errors if already stopped (e.g., due to natural end)
    if ((error as DOMException).name !== "InvalidStateError") {
      console.warn(
        `[Audio Playback] Error stopping source for instance ${instanceKey}:`,
        error,
      );
    }
    // The ramp could not be scheduled — release the source right away so it
    // can never be left playing without a way to stop it
    disposeTrackSource(source);
  }

  // Remove state immediately so the layer can no longer block re-triggering
  clearTrackState(instanceKey);

  return true;
}

/**
 * Stops every layer of a pad immediately.
 *
 * The name and the meaning are unchanged for a pad with one sound. For a pad
 * that layers, the Active Tracks row, the ESC key and the "stop" behaviour all
 * mean the pad, so they all end up here.
 *
 * @param baseKey - The pad's own playback key, or any instance key of it
 * @returns True if at least one instance was stopped
 */
export function stopTrack(baseKey: string): boolean {
  const base = baseKeyOf(baseKey);

  // Invalidate any trigger for *this pad* that still waits on an async load.
  // Deliberately not global: stopping one pad must not cancel another's.
  keyStopGenerations.set(base, (keyStopGenerations.get(base) ?? 0) + 1);

  let stopped = false;
  for (const instanceKey of getLayerKeys(base)) {
    if (stopInstance(instanceKey)) stopped = true;
  }
  return stopped;
}

/**
 * Stops all currently playing audio tracks
 *
 * @returns Number of tracks that were stopped
 */
export function stopAllTracks(): number {
  // One key per pad, so each pad's stop generation is bumped exactly once —
  // `stopTrack` below already reaches every layer of the pad it names.
  const keys = Array.from(layersByBase.keys());

  // Invalidate in-flight triggers for every pad, even ones with nothing
  // currently playing — a trigger that has not registered a track yet is
  // exactly what the panic button has to be able to reach.
  globalStopGeneration++;

  // Stop each track
  let stoppedCount = 0;
  keys.forEach((key) => {
    if (stopTrack(key)) {
      stoppedCount++;
    }
  });

  // Clear the store
  playbackStoreActions.clearAllTracks();

  console.log(
    `[Audio Playback] Stopped ${stoppedCount}/${keys.length} active tracks`,
  );
  return stoppedCount;
}

/**
 * Fade out all currently playing audio tracks
 *
 * @param durationInSeconds - Duration of the fade-out in seconds
 * @returns Number of tracks that were faded out
 */
export function fadeOutAllTracks(durationInSeconds: number = 3): number {
  const keys = Array.from(activeTracks.keys());

  let fadedCount = 0;
  keys.forEach((key) => {
    // Check if the instance is already fading to avoid restarting the fade
    if (!activeTracks.get(key)?.isFading) {
      if (fadeOutInstance(key, durationInSeconds)) {
        fadedCount++;
      }
    }
  });

  console.log(
    `[Audio Playback] Initiated fade out for ${fadedCount}/${keys.length} active tracks over ${durationInSeconds} seconds`,
  );

  return fadedCount;
}

// --- Playback Monitoring Loop ---

/**
 * Threshold for progress change detection (0.1% = 0.001)
 * Prevents unnecessary updates for tiny progress changes
 */
const PROGRESS_CHANGE_THRESHOLD = 0.001;

/**
 * Threshold for time change detection (10ms)
 * Prevents updates for sub-frame time changes
 */
const TIME_CHANGE_THRESHOLD = 0.01;

/**
 * Check if playback state has meaningfully changed
 */
function hasPlaybackStateChanged(
  key: string,
  newProgress: number,
  newRemainingTime: number,
  newIsFading: boolean,
): boolean {
  const previous = previousPlaybackState.get(key);

  if (!previous) {
    return true; // New track, definitely changed
  }

  // Check for meaningful changes
  const progressChanged =
    Math.abs(newProgress - previous.progress) >= PROGRESS_CHANGE_THRESHOLD;
  const timeChanged =
    Math.abs(newRemainingTime - previous.remainingTime) >=
    TIME_CHANGE_THRESHOLD;
  const fadingChanged = newIsFading !== previous.isFading;

  return progressChanged || timeChanged || fadingChanged;
}

/**
 * Optimized single frame of the playback monitoring loop
 * Only updates UI state when values actually change
 */
function playbackLoopTick() {
  if (!getAudioContext || activeTracks.size === 0) {
    stopPlaybackLoop(); // Stop if context lost or no tracks
    return;
  }

  const context = getAudioContext();
  const currentTime = context.currentTime;
  let hasAnyChanges = false;
  const currentPlaybackState = new Map();
  const newPreviousState = new Map();

  activeTracks.forEach((track, key) => {
    let elapsed: number;

    if (track.source.kind === "media") {
      const element = track.source.element;

      // The full duration is unknown until the element loads its metadata;
      // fill it in as soon as it becomes available
      if (
        track.duration <= 0 &&
        isFinite(element.duration) &&
        element.duration > 0
      ) {
        track.duration = (track.trimEnd ?? element.duration) - track.trimStart;
      }

      elapsed = Math.max(0, element.currentTime - track.trimStart);

      // Backstop for the scheduled cut in `scheduleStreamingTrimEnd`. That is
      // what actually ends a trimmed streamed track, and it is what works in a
      // hidden tab, where this loop is not running at all. This stays for the
      // cases the schedule cannot see — a media element that reports a
      // position ahead of where it was seeked, say — and it costs a
      // comparison per frame.
      if (
        track.trimEnd !== undefined &&
        element.currentTime >= track.trimEnd &&
        !track.isFading
      ) {
        console.log(
          `[Audio Playback] Streaming playback reached trim end for key: ${key}`,
        );
        try {
          stopSourcePlayback(track.source);
        } catch {
          // Ignore — element may already be paused
        }
        cleanupTrack(key);
        return;
      }
    } else {
      elapsed = currentTime - track.startTime;
    }

    const hasKnownDuration = track.duration > 0;
    const remaining = hasKnownDuration
      ? Math.max(0, track.duration - elapsed)
      : 0;
    const progress = hasKnownDuration
      ? Math.min(1, elapsed / track.duration)
      : 0;

    // If remaining time is effectively zero and it's not already fading,
    // treat it as ended (handles cases where onended might be delayed)
    if (hasKnownDuration && remaining <= 0 && !track.isFading) {
      // This track should be removed, but let onended handle the primary cleanup.
      // We'll just exclude it from the state update for this tick.
      return; // Skip adding to current state if naturally ended
    }

    // Check if this track's state has meaningfully changed
    const hasChanged = hasPlaybackStateChanged(
      key,
      progress,
      remaining,
      track.isFading,
    );

    if (hasChanged) {
      hasAnyChanges = true;
    }

    // Create state object - reuse object structure to reduce garbage collection
    // Note: We still create new objects per track, but with consistent structure
    currentPlaybackState.set(key, {
      key,
      name: track.name,
      remainingTime: remaining,
      totalDuration: track.duration,
      progress: progress,
      isFading: track.isFading,
      padInfo: track.padInfo,
    });

    // Update our change detection state - create new object for each track
    newPreviousState.set(key, {
      progress,
      remainingTime: remaining,
      isFading: track.isFading,
    });
  });

  // Only update Zustand store if something actually changed
  if (currentPlaybackState.size > 0 && hasAnyChanges) {
    playbackStoreActions.setPlaybackState(currentPlaybackState);

    // Only advance the comparison baseline for the state we just published,
    // otherwise small per-frame deltas never accumulate past the thresholds
    newPreviousState.forEach((state, key) => {
      previousPlaybackState.set(key, state);
    });
  }

  if (activeTracks.size > 0) {
    // Always schedule next frame regardless of changes (tracks are still playing)
    rAFId = requestAnimationFrame(playbackLoopTick);
  } else {
    // No tracks left, stop the loop and clear previous state
    previousPlaybackState.clear();
    stopPlaybackLoop();
  }
}

/**
 * Starts the playback monitoring loop if not already running
 */
function startPlaybackLoop() {
  // Only start if we have tracks and the loop isn't already running
  if (
    rAFId === null &&
    activeTracks.size > 0 &&
    typeof window !== "undefined"
  ) {
    console.log("[Audio Playback] Starting playback monitoring loop...");
    rAFId = requestAnimationFrame(playbackLoopTick);
  }
}

/**
 * Stops the playback monitoring loop, but only if no tracks remain active
 */
function stopPlaybackLoopIfIdle() {
  if (activeTracks.size === 0) {
    stopPlaybackLoop();
  }
}

/**
 * Stops the playback monitoring loop
 */
function stopPlaybackLoop() {
  if (rAFId !== null) {
    console.log("[Audio Playback] Stopping playback monitoring loop.");
    cancelAnimationFrame(rAFId);
    rAFId = null;
  }
}
