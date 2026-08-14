/**
 * Audio Module - Core Playback
 *
 * Handles the creation and management of audio playback sources.
 * Provides functions for playing, stopping, and fading audio.
 *
 * @module lib/audio/playback
 */

import { getAudioContext } from "./context";
import { ActiveTrack, PlayAudioParams, TrackSource } from "./types";
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

// Incremented whenever playback is stopped, so in-flight triggers can be cancelled
let stopGeneration = 0;

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
 * Returns the current stop generation counter
 *
 * Callers that await asynchronous work before starting playback can capture this
 * value and compare it afterwards to detect that a stop was requested meanwhile.
 *
 * @returns The current stop generation
 */
export function getStopGeneration(): number {
  return stopGeneration;
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
 * Removes all bookkeeping for a track and stops the monitoring loop if idle.
 *
 * Does not touch the underlying source — callers decide whether the source
 * is released immediately or after a de-click ramp.
 *
 * @param playbackKey - The unique key for the playback
 */
function clearTrackState(playbackKey: string): void {
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

  if (track && track.source.kind === "media") {
    disposeMediaSource(track.source);
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
  if (activeTracks.get(playbackKey) === track) {
    cleanupTrack(playbackKey);
  } else {
    disposeTrackSource(track.source);
  }
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

    activeTracks.set(playbackKey, track);

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
      },
      { once: true },
    );

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

    activeTracks.set(playbackKey, track);

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
 * Checks if a track is currently playing
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track is playing
 */
export function isTrackPlaying(playbackKey: string): boolean {
  return activeTracks.has(playbackKey);
}

/**
 * Checks if a track is currently fading out
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track is fading
 */
export function isTrackFading(playbackKey: string): boolean {
  return activeTracks.get(playbackKey)?.isFading === true;
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
 * Gets information about a specific active track
 *
 * @param playbackKey - The unique key for the playback
 * @returns The active track information or null if not found
 */
export function getActiveTrack(playbackKey: string): ActiveTrack | null {
  return activeTracks.get(playbackKey) || null;
}

// Which sound a multi-sound pad picked is invisible in the UI — the Active
// Tracks panel shows the pad's name, not the selected file's — so the playback
// mode tests read the selection through this hook. See lib/testHooks.
exposeE2EHook("__impampActiveSounds", () =>
  Array.from(activeTracks.entries()).map(([key, track]) => ({
    key,
    name: track.name,
    playbackType: track.playbackType,
    currentAudioFileId: track.currentAudioFileId,
    currentAudioIndex: track.currentAudioIndex,
    allAudioFileIds: track.allAudioFileIds,
  })),
);

/**
 * Initiates a fade-out for a track
 *
 * @param playbackKey - The unique key for the playback
 * @param durationInSeconds - Duration of the fade-out in seconds
 * @returns True if fade-out was initiated successfully
 */
export function fadeOutTrack(
  playbackKey: string,
  durationInSeconds: number,
): boolean {
  const track = activeTracks.get(playbackKey);

  // If track doesn't exist or is already fading, do nothing
  if (!track || track.isFading) return false;

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
 * Stops playback of a track immediately, cancelling any fade in progress
 *
 * @param playbackKey - The unique key for the playback
 * @returns True if the track was stopped successfully
 */
export function stopTrack(playbackKey: string): boolean {
  console.log(`[Audio Playback] Requesting stop for key: ${playbackKey}`);

  const track = activeTracks.get(playbackKey);
  if (!track) return false;

  // Invalidate any trigger that is still waiting on an async load
  stopGeneration++;

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
        `[Audio Playback] Error stopping source for key ${playbackKey}:`,
        error,
      );
    }
    // The ramp could not be scheduled — release the source right away so it
    // can never be left playing without a way to stop it
    disposeTrackSource(source);
  }

  // Remove state immediately so the track can no longer block re-triggering
  clearTrackState(playbackKey);

  return true;
}

/**
 * Stops all currently playing audio tracks
 *
 * @returns Number of tracks that were stopped
 */
export function stopAllTracks(): number {
  // Get all keys from activeTracks
  const keys = Array.from(activeTracks.keys());

  // Invalidate in-flight triggers even when nothing is currently playing
  stopGeneration++;

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
    // Check if the track is already fading to avoid restarting the fade
    if (!isTrackFading(key)) {
      if (fadeOutTrack(key, durationInSeconds)) {
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

      // Enforce the trim end manually — buffer sources handle this natively
      // via source.start(when, offset, duration), media elements don't
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
