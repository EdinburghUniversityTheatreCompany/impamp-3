/**
 * Audio Module - Types
 *
 * Common types and interfaces for the audio module.
 * Defines the strategy pattern interfaces for different playback types.
 *
 * @module lib/audio/types
 */

import { ActivePadBehavior, PlaybackType } from "../db";

/**
 * Playback strategy interface for implementing different audio selection strategies
 * (sequential, random, round-robin)
 */
export interface PlaybackStrategy {
  /**
   * Selects the next sound to play from the array of available audio file IDs
   *
   * @param audioFileIds - Array of available audio file IDs
   * @returns Object containing the selected audioFileId and its index in the array
   */
  selectNextSound(audioFileIds: number[]): {
    audioFileId: number;
    index: number;
  };

  /**
   * Updates the internal state of the strategy after a sound has been played
   *
   * @param playedIndex - Index of the sound that was just played
   * @param audioFileIds - Array of all available audio file IDs
   */
  updateState(playedIndex: number, audioFileIds: number[]): void;

  /**
   * Which sounds this strategy has not played yet in the current cycle, if
   * that is a thing it tracks.
   *
   * Optional because only round-robin has a cycle. It lives on the interface
   * so `controls.ts` can ask any strategy and get `undefined` from the ones
   * with nothing to say — it used to branch on `playbackType === "round-robin"`
   * and cast the result to the concrete class, which is the one place the
   * strategy abstraction was not carrying its weight.
   */
  getAvailableIndices?(): number[];
}

/**
 * The underlying audio source for an active track.
 *
 * - "buffer": a fully decoded AudioBuffer played through an
 *   AudioBufferSourceNode (sample-accurate, used when the decoded buffer
 *   is already cached)
 * - "media": an HTMLAudioElement streaming directly from the stored blob
 *   (starts almost immediately without decoding the whole file, used when
 *   no decoded buffer is available)
 */
export type TrackSource =
  | {
      kind: "buffer";
      sourceNode: AudioBufferSourceNode;
    }
  | {
      kind: "media";
      element: HTMLAudioElement;
      sourceNode: MediaElementAudioSourceNode;
      objectUrl: string;
    };

/**
 * Represents a currently playing audio track
 */
export interface ActiveTrack {
  source: TrackSource;
  /**
   * The track's own gain node, inserted between the source and the
   * destination when playback starts. Fades and hard stops automate this
   * existing node in place — the graph is never re-plumbed mid-playback,
   * which would otherwise reset the level to full volume.
   */
  gainNode: GainNode;
  name: string;
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd?: number;
  /**
   * The timer that ends a streamed track at its trim end.
   *
   * Only media element sources carry one. A buffer source is given its window
   * up front via `source.start(when, offset, duration)` and needs nothing
   * else; a media element has no equivalent, so the cut is scheduled instead
   * of polled — see `scheduleStreamingTrimEnd`.
   */
  trimEndTimer?: ReturnType<typeof setTimeout>;
  padInfo: {
    profileId: number;
    bankId: string;
    padIndex: number;
  };
  isFading: boolean;
  // Multi-sound state
  playbackType: PlaybackType;
  allAudioFileIds: number[]; // The full list for this pad
  currentAudioFileId: number; // The specific ID currently playing
  currentAudioIndex?: number; // Index within allAudioFileIds
  availableAudioIndices?: number[]; // Remaining indices for round-robin
}

/**
 * Arguments for triggering audio playback
 */
export interface TriggerAudioArgs {
  padIndex: number;
  audioFileIds: number[];
  playbackType: PlaybackType;
  activeProfileId: number;
  currentBankId: string;
  name?: string;
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  /** Per-sound manual gain in dB, keyed by audio file ID. */
  audioGainSettings: Record<number, number> | undefined;
  /** Whole-pad manual gain in dB. */
  padGainDb: number | undefined;
  /**
   * When true the pad is disabled and playback is refused. Every trigger path
   * passes this through so the guard lives in one place.
   */
  isDisabled?: boolean;
  /**
   * This pad's own override of the profile's activePadBehavior. Undefined means
   * follow the profile.
   */
  activePadBehavior?: ActivePadBehavior;
}

/**
 * Parameters for creating and playing an audio source
 */
export interface PlayAudioParams {
  name: string;
  padInfo: {
    profileId: number;
    bankId: string;
    padIndex: number;
  };
  volume?: number;
  trimStart?: number;
  trimEnd?: number;
  multiSoundState: {
    playbackType: PlaybackType;
    allAudioFileIds: number[];
    currentAudioFileId: number;
    currentAudioIndex?: number;
    availableAudioIndices?: number[];
  };
}

/**
 * Helper for generating playback keys in a consistent format
 *
 * @param profileId - Profile ID
 * @param bankId - Bank identity
 * @param padIndex - Pad index
 * @returns Formatted playback key string
 */
export function generatePlaybackKey(
  profileId: number,
  bankId: string,
  padIndex: number,
): string {
  return `pad-${profileId}-${bankId}-${padIndex}`;
}

/**
 * The largest number of layers one pad plays at the same time.
 *
 * A trigger past the cap stops the oldest layer and starts a new one, so a
 * trigger always makes a sound. 16 is high enough for applause or a rain bed,
 * and low enough that a stuck key cannot fill the audio graph.
 */
export const MAX_LAYERS_PER_PAD = 16;

/**
 * Separator between a base key and its layer number.
 *
 * `generatePlaybackKey` joins the profile id, bank id and pad index with
 * "-", and a bank id is a string identity that can itself contain almost
 * anything: it can be a UUID (so it can contain hyphens), and one imported
 * from an archive arrives with no character-set validation at all
 * (`importExport.ts` passes `page.bankId` / `pad.bankId` straight through
 * from parsed JSON). So a bank id can contain this separator too, and
 * recovering a base key from an instance key can't just split on the first
 * one of these — see `splitInstanceKey` below for how it copes with that.
 */
const LAYER_SEPARATOR = "#";

/**
 * Builds the key one layer of a pad plays under.
 *
 * @param baseKey - The pad's own playback key
 * @param layerIndex - The layer number, which grows and is never reused
 * @returns The instance key
 */
export function makeInstanceKey(baseKey: string, layerIndex: number): string {
  return `${baseKey}${LAYER_SEPARATOR}${layerIndex}`;
}

/**
 * Splits a key into the base key and layer number an instance key encodes,
 * or `null` when the key carries no instance suffix.
 *
 * `makeInstanceKey` always appends the separator last, so its layer number is
 * always the tail after the *rightmost* separator in the string — splitting
 * on the first one, like an earlier version of this function did, mis-splits
 * as soon as a bank id contains the separator itself. The tail is also
 * required to be all digits before it's trusted as a layer number, so a bank
 * id that merely contains the separator (followed by anything other than a
 * bare number) still round-trips as a base key with no instance.
 *
 * That is total and correct for any bank id except one that makes the whole
 * key end in `#<digits>` with nothing after — a bank id ending in the
 * separator immediately followed only by digits, and nothing else, right at
 * the end of the string. `generatePlaybackKey` always appends `-${padIndex}`
 * after the bank id, so that shape can't arise from a key this module built;
 * it is a residual risk only for a string built some other way.
 *
 * @param key - A base key or an instance key
 * @returns The split, or `null` if `key` is a bare base key
 */
function splitInstanceKey(key: string): { base: string; layer: number } | null {
  const at = key.lastIndexOf(LAYER_SEPARATOR);
  if (at === -1) return null;
  const suffix = key.slice(at + 1);
  if (!/^\d+$/.test(suffix)) return null;
  const layer = Number.parseInt(suffix, 10);
  return Number.isFinite(layer) ? { base: key.slice(0, at), layer } : null;
}

/**
 * The pad an instance key belongs to.
 *
 * A bare base key is its own instance key, so a pad that never layers keeps
 * exactly the key space it had before.
 *
 * @param key - A base key or an instance key
 * @returns The base key
 */
export function baseKeyOf(key: string): string {
  return splitInstanceKey(key)?.base ?? key;
}

/**
 * The layer number an instance key carries.
 *
 * A bare base key answers 0, so a sort by this number puts a pad's single
 * un-layered track first.
 *
 * @param key - A base key or an instance key
 * @returns The layer number
 */
export function layerIndexOf(key: string): number {
  return splitInstanceKey(key)?.layer ?? 0;
}
