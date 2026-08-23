/**
 * Whether this environment can do Web Audio at all.
 *
 * Its own module, and a shared one, because two places ask the question and
 * the repo's characteristic regression is the same rule written twice.
 * `getAudioContext` asks it to decide which constructor to call;
 * `startBackgroundAnalysis` asks it to decide whether to start an analysis
 * that would reach that constructor. Those two answers disagreeing is not a
 * theoretical problem: the guard was written as `typeof AudioContext`, which
 * is false on a browser carrying only the prefixed constructor — so playback
 * worked (`getAudioContext` falls back to `webkitAudioContext`) while nothing
 * was ever analysed, and every file played un-normalised at 0 dB, silently
 * and permanently.
 *
 * Nothing is imported here on purpose. `db.ts` needs the answer
 * synchronously, and must not drag the audio stack into every bundle that
 * touches the database to get it.
 *
 * @module lib/audio/capability
 */

/** `window` as it is on a browser that only carries the prefixed constructor. */
interface ExtendedWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * The `AudioContext` constructor this environment offers, or `undefined`.
 *
 * Read off `window` rather than through a bare `typeof AudioContext`, because
 * the prefixed one has never been a global binding — it is a property of
 * `window` and nothing else.
 */
export function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as ExtendedWindow).webkitAudioContext;
}

/** Whether Web Audio is available, prefixed or not. */
export function hasWebAudio(): boolean {
  return getAudioContextConstructor() !== undefined;
}
