/**
 * Audio Module - Context Management
 *
 * Manages the Web Audio API AudioContext.
 * Handles creation, initialization, and resuming of the audio context.
 *
 * @module lib/audio/context
 */

// Define an interface for window with potential webkitAudioContext
interface ExtendedWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

// Track client-side environment
const isClient = typeof window !== "undefined";
let audioContext: AudioContext | null = null;
let listenersRegistered = false;

/**
 * Gets or creates the AudioContext instance.
 * Creates a new context if one doesn't exist, and attempts to resume it if suspended.
 *
 * @returns The AudioContext instance
 * @throws Error if called on the server side
 */
export function getAudioContext(): AudioContext {
  // Ensure we only run this on the client side
  if (!isClient) {
    throw new Error("AudioContext is not available on the server");
  }

  if (!audioContext) {
    // Cast window to the extended type to check for webkitAudioContext (Safari support)
    const extendedWindow = window as ExtendedWindow;
    audioContext = new (
      window.AudioContext || extendedWindow.webkitAudioContext
    )();

    console.log("[Audio Context] Created new AudioContext instance");
    setupAudioContextListeners();
  }

  // Resume context if it was suspended or interrupted (e.g., due to browser autoplay policy or tab switching)
  // Note: "interrupted" is used by Safari and some Chrome versions when the tab is backgrounded
  if (
    audioContext.state === "suspended" ||
    (audioContext.state as string) === "interrupted"
  ) {
    audioContext.resume().catch((err) => {
      console.warn(
        "[Audio Context] Failed to automatically resume context:",
        err,
      );
    });
  }

  return audioContext;
}

/**
 * Explicitly resumes the AudioContext.
 * Should be called from a user interaction handler to satisfy browser autoplay policies.
 *
 * @returns A promise that resolves when the context has been resumed
 */
export function resumeAudioContext(): Promise<void> {
  const context = getAudioContext();
  // Also handle "interrupted" state used by Safari and some Chrome versions on tab switch
  if (
    context.state === "suspended" ||
    (context.state as string) === "interrupted"
  ) {
    console.log(
      "[Audio Context] Attempting to resume audio context from user interaction",
    );
    return context
      .resume()
      .then(() => {
        console.log("[Audio Context] Successfully resumed AudioContext");
      })
      .catch((err) => {
        console.error("[Audio Context] Failed to resume AudioContext:", err);
        throw err; // Re-throw for caller handling
      });
  }
  return Promise.resolve();
}

/**
 * Registers document/window event listeners to resume the AudioContext when
 * the user returns to the tab. Called once after the AudioContext is created.
 *
 * Does NOT suspend on tab hide — sounds currently playing should continue
 * uninterrupted while the tab is in the background.
 */
function setupAudioContextListeners(): void {
  if (!isClient || listenersRegistered) return;
  listenersRegistered = true;

  const handleVisibilityChange = () => {
    if (!document.hidden) {
      resumeAudioContext().catch(() => {
        // Ignore — will be retried on next user interaction
      });
    }
  };

  const handleFocus = () => {
    resumeAudioContext().catch(() => {
      // Ignore — will be retried on next user interaction
    });
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleFocus);
}
