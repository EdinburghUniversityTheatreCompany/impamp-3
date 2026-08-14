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

/**
 * A profile can sync right now if it's Drive-linked and either the user is
 * signed in, or the profile is read-only (public profiles pull through the
 * server-side proxy without a Google sign-in).
 */
const canSyncNow = (profile: Profile, isGoogleSignedIn: boolean): boolean =>
  profile.id !== undefined &&
  profile.syncType === "googleDrive" &&
  !!profile.googleDriveFileId &&
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
    const subscriptions = new Map<number, () => void>();

    const reconcileSubscriptions = (profiles: Profile[]) => {
      const wanted = new Map(
        profiles
          .filter((p) => isServerSynced(p) && p.serverProfileId)
          .map((p) => [p.id!, p]),
      );

      // Drop streams for profiles that are gone or no longer server-synced.
      for (const [profileId, unsubscribe] of subscriptions) {
        if (!wanted.has(profileId)) {
          unsubscribe();
          subscriptions.delete(profileId);
        }
      }

      for (const [profileId, profile] of wanted) {
        if (subscriptions.has(profileId)) continue;
        subscriptions.set(
          profileId,
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
