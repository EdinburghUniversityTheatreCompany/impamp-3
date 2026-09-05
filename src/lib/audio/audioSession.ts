/**
 * Which audio route this board asks the operating system for.
 *
 * On iOS this is the difference between a working board and a silent one.
 * Safari's default session type is `"auto"`, and for a page whose only output
 * is Web Audio that resolves to `"ambient"` — the category the hardware ringer
 * switch mutes. Every other symptom looks healthy, which is what makes it so
 * hard to diagnose from a bug report: the AudioContext reaches `"running"`,
 * the sources start and stop, the progress bars sweep, the Active Tracks panel
 * fills up, and the phone emits nothing. `<audio>` and `<video>` elements have
 * never been subject to the switch, so "the same file plays fine in Safari's
 * own player" is not evidence against this.
 *
 * Declaring `"playback"` moves the page onto the media route instead, which
 * the ringer switch does not touch. It is the right declaration on its merits
 * as well as its effect: this is a cue board for live use, where a sound is
 * the point of pressing the button, not decoration over something else.
 *
 * Two consequences on iOS come with `"playback"` and are wanted here. Other
 * apps' playback is paused rather than mixed with — an operator does not want
 * their own music under a cue — and audio keeps running when the screen locks
 * or the browser is backgrounded, which a board mid-show must do.
 *
 * Only Safari implements the Audio Session API today, and it is the only
 * browser that needs it: no other platform routes Web Audio through the
 * ringer switch. Everywhere else this is a no-op.
 *
 * @module lib/audio/audioSession
 */

/** `navigator` as it is on a browser carrying the Audio Session API. */
interface AudioSessionNavigator extends Navigator {
  audioSession?: { type: string };
}

/**
 * Declares this page media playback, so the iOS ringer switch cannot silence
 * it.
 *
 * Safe to call repeatedly, and safe to call on any browser: the API is
 * feature-detected, and an implementation that refuses the assignment is
 * warned about rather than thrown from. That last arm matters because the one
 * caller is on the trigger path — losing the cue to an exception raised while
 * deciding how to categorise it would be a far worse outcome than playing it
 * on the wrong route.
 */
export function configureAudioSessionForPlayback(): void {
  if (typeof navigator === "undefined") return;

  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session) return;

  try {
    session.type = "playback";
  } catch (err) {
    console.warn(
      "[Audio Session] Could not declare the playback audio session:",
      err,
    );
  }
}
