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
    audioContext = new (window.AudioContext ||
      extendedWindow.webkitAudioContext)();

    console.log("[Audio Context] Created new AudioContext instance");
  }

  // Resume context if it was suspended (e.g., due to browser autoplay policy)
  if (audioContext.state === "suspended") {
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
  if (context.state === "suspended") {
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
