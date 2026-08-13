/**
 * In-process pub/sub for "this profile changed" notifications.
 *
 * Subscribers are SSE connections held open by browsers watching a profile.
 * When a write lands, everyone else watching gets told the new version and
 * pulls — which is what takes collaboration latency from the Drive model's
 * 15 minutes down to about a second.
 *
 * This is deliberately in-process: the app runs as a single container behind
 * Kamal, so there is no second instance to fan out to. Running more than one
 * replica would need an external bus (Redis pub/sub or Postgres LISTEN) —
 * until then, notifications would only reach viewers on the same instance,
 * with the client's periodic poll as the safety net.
 */

export interface ProfileChange {
  profileId: string;
  version: number;
  /** Session that made the change, so it can ignore its own echo. */
  originId?: string;
}

type Listener = (change: ProfileChange) => void;

const listeners = new Map<string, Set<Listener>>();

/** Watch one profile. Returns an unsubscribe function. */
export function subscribeToProfile(
  profileId: string,
  listener: Listener,
): () => void {
  let forProfile = listeners.get(profileId);
  if (!forProfile) {
    forProfile = new Set();
    listeners.set(profileId, forProfile);
  }
  forProfile.add(listener);

  return () => {
    const current = listeners.get(profileId);
    if (!current) return;
    current.delete(listener);
    // Don't leak an empty Set per profile that was ever watched.
    if (current.size === 0) listeners.delete(profileId);
  };
}

/** Tell every watcher of a profile that it changed. */
export function publishProfileChange(change: ProfileChange): void {
  const forProfile = listeners.get(change.profileId);
  if (!forProfile) return;

  for (const listener of forProfile) {
    try {
      listener(change);
    } catch (error) {
      // One broken connection must not stop the others being notified.
      console.error("Profile change listener failed:", error);
    }
  }
}

/** Number of live watchers, for tests and diagnostics. */
export function watcherCount(profileId: string): number {
  return listeners.get(profileId)?.size ?? 0;
}
