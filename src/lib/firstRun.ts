/**
 * Whether this device has been shown the welcome tour.
 *
 * `localStorage`, not the profile, and that is the whole decision. The tour
 * teaches the *application* — where the bank tabs are, that a pad is a key —
 * which is a fact about this browser, not about a board. Putting it on the
 * profile would sync it, so setting up a second device would silently skip
 * the tour on the machine that most needs it, and a shared board would carry
 * one collaborator's answer to everyone else.
 *
 * Every access is guarded. `localStorage` throws rather than returning null in
 * a Safari private window and wherever site data is blocked, and this runs on
 * the first paint of the app's only page — a throw here would take the whole
 * board down to decide whether to show a tutorial. Failing closed (treating an
 * unreadable store as "already seen") is the right way round: the cost is a
 * tour nobody sees, against a modal that reappears on every load with no way
 * to dismiss it permanently.
 */

const SEEN_KEY = "impamp:welcomeTourSeen";

/** True when the tour has been completed or dismissed on this device. */
export function hasSeenWelcomeTour(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/** Records that the tour has been completed or dismissed. */
export function markWelcomeTourSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // A device that cannot remember the answer gets asked again next load,
    // which is worse than not asking but better than failing to start.
  }
}

/** Forgets the answer, so the tour can be replayed from Help. */
export function forgetWelcomeTourSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SEEN_KEY);
  } catch {
    // Nothing to do: the caller is about to open the tour anyway.
  }
}
