"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const AUTO_SYNC_DEBOUNCE_MS = 10_000; // 10 seconds after the last edit
const REMOTE_CHECK_INTERVAL_MS = 30_000; // light remote-change poll cadence
const REMOTE_CHECK_MIN_GAP_MS = 10_000; // min gap between event-triggered checks
const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000; // unconditional full-sync backstop
import { useProfileStore } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import {
  subscribeToProfileChanges,
  useServerSync,
} from "@/hooks/useServerSync";
import { getAllProfiles, getProfile, Profile } from "@/lib/db";
import {
  BORROWED_LINK_SWEEP_KEY,
  reconcileBorrowedDriveLinks,
} from "@/lib/syncReconcile";

/**
 * A profile can sync right now if it's Drive-linked and either the user is
 * signed in, or the profile is read-only (public profiles pull through the
 * server-side proxy without a Google sign-in).
 */
const canSyncNow = (profile: Profile, isGoogleSignedIn: boolean): boolean =>
  profile.id !== undefined &&
  profile.syncType === "googleDrive" &&
  !!profile.googleDriveFileId &&
  // A viewer is promised it keeps receiving: the engine pulls a read-only
  // profile anonymously through the public proxy, so gating this on the Google
  // token alone quietly stopped that the moment the token lapsed.
  //
  // `readOnly` and not `isReadOnlyForSync`, because only the first is the
  // remote's answer. Following is a preference, not a permission — a private
  // profile you own and follow is not public, and sending it down the proxy
  // path just fails with a misleading "ask the owner to share it" every poll.
  (isGoogleSignedIn || !!profile.readOnly);

/**
 * Server-synced profiles need no sign-in check here: a link-share token is
 * enough for a viewer, and the server rejects anything else.
 */
const isServerSynced = (profile: Profile): boolean =>
  profile.id !== undefined && profile.syncType === "server";

/**
 * This component ensures that the initial profile fetching (which involves DB access)
 * happens only on the client-side after the initial render.
 * It also handles automatic sync for Google Drive-linked profiles.
 */
const ClientSideInitializer: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // Get syncProfile from the hook but avoid direct store access in render
  const { syncProfile, getRemoteVersionToken } = useGoogleDriveSync();
  const { syncProfile: syncServerProfile } = useServerSync();

  // Use local state to store auth values from the Zustand store
  const [isGoogleSignedIn, setIsGoogleSignedIn] = useState(false);

  // Subscribe to store changes for Google sign-in state. Every subscription in
  // this component is selector-based (see subscribeWithSelector in
  // profileStore), so it is woken only when its own slice changes rather than
  // on every store mutation.
  useEffect(
    () =>
      useProfileStore.subscribe(
        (state) => state.isGoogleSignedIn,
        setIsGoogleSignedIn,
        { fireImmediately: true },
      ),
    [],
  );

  useEffect(() => {
    // Fetch profiles only once when the component mounts on the client
    console.log("ClientSideInitializer mounted, fetching initial profiles...");
    useProfileStore.getState().fetchProfiles();
  }, []); // Empty dependency array ensures this runs only once on mount

  // One-off repair for profiles imported from a server share link before the
  // import stopped copying the owner's Drive ids. Left in place, those ids
  // make server sync attempt uploads into a folder this device does not own.
  // Runs before the first sync so a stale link never gets used, and the flag
  // keeps it from walking every profile on every load.
  useEffect(() => {
    if (localStorage.getItem(BORROWED_LINK_SWEEP_KEY)) return;
    void reconcileBorrowedDriveLinks()
      .then((repaired) => {
        localStorage.setItem(BORROWED_LINK_SWEEP_KEY, "1");
        if (repaired > 0) useProfileStore.getState().fetchProfiles();
      })
      .catch((error) => {
        // Leave the flag unset so the next load tries again.
        console.warn("Could not reconcile borrowed Drive links:", error);
      });
  }, []);

  // Loudness: keep the in-memory gain-resolution cache in sync with whichever
  // profile is active, and sweep older files for measurement in the
  // background. `warmLoudnessCache` (called inside `loadProfileLoudness`)
  // replaces the whole cache, so this effect is what honours that contract —
  // without it, the previous profile's analysis would stay resident and a
  // different profile's sounds would resolve gain from it.
  //
  // `refreshProfileLoudness` bundles the warm/backfill/warm-again sequence;
  // it is also called from `ProfileCard`'s re-analyse action and from
  // `applySyncedProfile`, and is safe to call from more than one place at
  // once — `runBackfill` inside it coalesces concurrent callers rather than
  // one superseding another.
  //
  // `cancelled` here only saves this effect instance from doing pointless
  // work (starting a backfill, or a load) after its own profile has been
  // left. It is not what prevents a stale write: the dynamic import can
  // still resolve after `cancelled` flips. The actual guarantee that a
  // superseded load can never clobber a newer one lives in pipeline.ts's
  // `loadGeneration` token, which gates the write itself.
  const [activeProfileId, setActiveProfileId] = useState<number | null>(null);

  useEffect(
    () =>
      useProfileStore.subscribe(
        (state) => state.activeProfileId,
        setActiveProfileId,
        { fireImmediately: true },
      ),
    [],
  );

  useEffect(() => {
    if (activeProfileId === null) return;

    let cancelled = false;
    void (async () => {
      const { refreshProfileLoudness } =
        await import("@/lib/audio/loudness/pipeline");
      if (cancelled) return;
      await refreshProfileLoudness(activeProfileId);
    })().catch((error) => {
      // Analysis failing must never surface as an unhandled rejection — an
      // unanalysed file simply plays at 0 dB. getDb()/getAudioFileIdsForProfile/
      // findUnanalysedAudioFileIds calls inside refreshProfileLoudness sit
      // outside analyseAndStore's own try/catch, so this is the backstop for
      // those.
      console.warn(
        `[Loudness] Profile loudness refresh failed for profile ${activeProfileId}:`,
        error,
      );
    });

    // Avoids starting a refresh for a profile the user has already left —
    // see the generation-token note above for why this alone is not the
    // correctness guarantee.
    return () => {
      cancelled = true;
    };
  }, [activeProfileId]);

  // Last-seen remote version token per profile. Updated after every sync so
  // the remote-change poller doesn't re-trigger on our own uploads.
  const lastRemoteTokenRef = useRef<Map<number, string>>(new Map());
  const lastRemoteCheckAtRef = useRef(0);
  const remoteCheckInFlightRef = useRef(false);

  // Record the current remote version of a profile's Drive file
  const recordRemoteToken = useCallback(
    async (profileId: number) => {
      try {
        const profile = await getProfile(profileId);
        if (profile?.googleDriveFileId) {
          const token = await getRemoteVersionToken(profile.googleDriveFileId);
          if (token) lastRemoteTokenRef.current.set(profileId, token);
        }
      } catch (error) {
        console.warn(
          `Could not record remote version for profile ${profileId}:`,
          error,
        );
      }
    },
    [getRemoteVersionToken],
  );

  // Sync a profile and remember the resulting remote version so the change
  // poller doesn't immediately re-sync in response to our own upload.
  const syncAndRecord = useCallback(
    async (profileId: number) => {
      const result = await syncProfile(profileId);
      await recordRemoteToken(profileId);
      return result;
    },
    [syncProfile, recordRemoteToken],
  );

  // Sync every profile that can sync under the current auth state
  const syncAllEligibleProfiles = useCallback(
    async (reason: string) => {
      try {
        const signedIn = useProfileStore.getState().isGoogleSignedIn;
        const profiles = await getAllProfiles();

        for (const profile of profiles) {
          if (profile.id === undefined) continue;

          if (isServerSynced(profile)) {
            console.log(
              `Syncing server profile ${profile.id} (${profile.name}) — ${reason}...`,
            );
            await syncServerProfile(profile.id);
            continue;
          }

          if (!canSyncNow(profile, signedIn)) continue;
          console.log(
            `Syncing profile ${profile.id} (${profile.name}) — ${reason}...`,
          );
          await syncAndRecord(profile.id);
        }
      } catch (error) {
        console.error(`Error during ${reason} sync:`, error);
      }
    },
    [syncAndRecord, syncServerProfile],
  );

  /**
   * Light remote-change check: compares each Drive file's version token
   * against the last one we saw and runs a full sync only when it changed.
   * Cheap enough to run every 30 seconds, on window focus, and when
   * entering edit mode.
   */
  const checkForRemoteChanges = useCallback(
    async (targetProfileIds?: number[]) => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      if (remoteCheckInFlightRef.current) return;
      const now = Date.now();
      if (now - lastRemoteCheckAtRef.current < REMOTE_CHECK_MIN_GAP_MS) return;
      lastRemoteCheckAtRef.current = now;
      remoteCheckInFlightRef.current = true;

      try {
        const signedIn = useProfileStore.getState().isGoogleSignedIn;
        const profiles = await getAllProfiles();

        for (const profile of profiles) {
          const id = profile.id;
          const fileId = profile.googleDriveFileId;
          if (id === undefined || !fileId) continue;
          if (!canSyncNow(profile, signedIn)) continue;
          if (targetProfileIds && !targetProfileIds.includes(id)) continue;

          try {
            const remoteToken = await getRemoteVersionToken(fileId);
            if (!remoteToken) continue; // can't determine — skip quietly

            const lastSeen = lastRemoteTokenRef.current.get(id);
            if (lastSeen === undefined) {
              // First observation — the on-load sync covers the initial pull
              lastRemoteTokenRef.current.set(id, remoteToken);
              continue;
            }
            if (lastSeen === remoteToken) continue;

            console.log(
              `Remote change detected for profile ${id} — syncing...`,
            );
            lastRemoteTokenRef.current.set(id, remoteToken);
            await syncAndRecord(id);
          } catch (error) {
            console.warn(
              `Remote change check failed for profile ${id}:`,
              error,
            );
          }
        }
      } finally {
        remoteCheckInFlightRef.current = false;
      }
    },
    [getRemoteVersionToken, syncAndRecord],
  );

  // Auto-sync on load and when Google auth changes. Runs even when signed
  // out so public read-only profiles stay fresh via the server-side proxy.
  useEffect(() => {
    syncAllEligibleProfiles(
      isGoogleSignedIn ? "app load (signed in)" : "app load",
    );
  }, [isGoogleSignedIn, syncAllEligibleProfiles]);

  // Network connectivity change detection
  useEffect(() => {
    const handleOnline = () => {
      console.log("Network connection restored. Syncing profiles...");
      syncAllEligibleProfiles("network reconnect");
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [syncAllEligibleProfiles]);

  // Debounced auto-sync after edits (10 seconds after last edit)
  const debounceTimersRef = useRef<
    Record<number, ReturnType<typeof setTimeout>>
  >({});

  useEffect(() => {
    // Captured once: the ref holds a single object that is mutated in place and
    // never reassigned, so this is the same map the cleanup needs — but reading
    // ref.current inside a cleanup is a pattern the lint rule cannot tell apart
    // from the dangerous kind, and the fix costs nothing.
    const debounceTimers = debounceTimersRef.current;

    const unsubscribe = useProfileStore.subscribe(
      (state) => state.syncRequestQueue,
      (syncRequestQueue) => {
        Object.keys(syncRequestQueue).forEach((key) => {
          const profileId = parseInt(key);
          if (debounceTimersRef.current[profileId]) {
            clearTimeout(debounceTimersRef.current[profileId]);
          }
          debounceTimersRef.current[profileId] = setTimeout(async () => {
            delete debounceTimersRef.current[profileId];
            const { profiles, isGoogleSignedIn } = useProfileStore.getState();
            const profile = profiles.find((p) => p.id === profileId);
            if (profile?.syncType === "server") {
              console.log(
                `Auto-syncing server profile ${profileId} after edit (debounced)...`,
              );
              await syncServerProfile(profileId);
            } else if (
              isGoogleSignedIn &&
              profile?.syncType === "googleDrive" &&
              profile.googleDriveFileId
            ) {
              console.log(
                `Auto-syncing profile ${profileId} after edit (debounced)...`,
              );
              await syncAndRecord(profileId);
            }
          }, AUTO_SYNC_DEBOUNCE_MS);
        });
      },
    );

    return () => {
      unsubscribe();
      Object.values(debounceTimers).forEach(clearTimeout);
    };
  }, [syncAndRecord, syncServerProfile]);

  // Live change notifications for server-synced profiles.
  //
  // This is what server sync buys over Drive: instead of polling, the server
  // pushes "profile N moved to version V" and we pull immediately. The
  // periodic full sync below stays as a backstop for a dropped stream.
  useEffect(() => {
    // Keyed on everything the stream is *for*, not just which profile it
    // belongs to. Keyed by profile id alone, a profile that was re-linked to a
    // different server profile, or whose share token was rotated or revoked
    // and re-issued, kept its old EventSource: the `continue` below saw a
    // subscription already existed and left it pointed at the old id. It then
    // either 401s forever — `onerror` only logs — or delivers changes for a
    // profile this device is no longer looking at.
    const subscriptions = new Map<string, () => void>();

    const streamKeyFor = (profile: Profile) =>
      `${profile.id}:${profile.serverProfileId}:${profile.serverShareToken ?? ""}`;

    const reconcileSubscriptions = (profiles: Profile[]) => {
      const wanted = new Map(
        profiles
          .filter((p) => isServerSynced(p) && p.serverProfileId)
          .map((p) => [streamKeyFor(p), p]),
      );

      // Drop streams for profiles that are gone, no longer server-synced, or
      // whose identity or credential has changed.
      for (const [streamKey, unsubscribe] of subscriptions) {
        if (!wanted.has(streamKey)) {
          unsubscribe();
          subscriptions.delete(streamKey);
        }
      }

      for (const [streamKey, profile] of wanted) {
        if (subscriptions.has(streamKey)) continue;
        const profileId = profile.id!;
        subscriptions.set(
          streamKey,
          subscribeToProfileChanges(
            profile.serverProfileId!,
            profile.serverShareToken ?? null,
            (version) => {
              console.log(
                `Server reports profile ${profileId} at version ${version} — syncing...`,
              );
              void syncServerProfile(profileId);
            },
          ),
        );
      }
    };

    const unsubscribeStore = useProfileStore.subscribe(
      (state) => state.profiles,
      reconcileSubscriptions,
      { fireImmediately: true },
    );

    return () => {
      unsubscribeStore();
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [syncServerProfile]);

  // Light remote-change poll (every 30 seconds while the tab is visible)
  useEffect(() => {
    const intervalId = setInterval(() => {
      checkForRemoteChanges();
    }, REMOTE_CHECK_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [checkForRemoteChanges]);

  // Check for remote changes when the window regains focus or visibility
  useEffect(() => {
    const handleFocus = () => {
      checkForRemoteChanges();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkForRemoteChanges();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkForRemoteChanges]);

  // Pull the active profile when entering edit mode so edits start from the
  // latest shared state
  useEffect(
    () =>
      useProfileStore.subscribe(
        (state) => state.isEditMode,
        (isEditMode, wasEditMode) => {
          if (!isEditMode || wasEditMode) return;
          const { activeProfileId } = useProfileStore.getState();
          if (activeProfileId !== null) {
            checkForRemoteChanges([activeProfileId]);
          }
        },
      ),
    [checkForRemoteChanges],
  );

  // Periodic full sync (every 15 minutes) as a backstop — also uploads local
  // changes that somehow missed the debounced sync and repairs drift
  useEffect(() => {
    const intervalId = setInterval(() => {
      console.log("Running periodic sync...");
      syncAllEligibleProfiles("periodic full sync");
    }, FULL_SYNC_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [syncAllEligibleProfiles]);

  // Render children immediately; the profile store will update asynchronously
  return <>{children}</>;
};

export default ClientSideInitializer;
