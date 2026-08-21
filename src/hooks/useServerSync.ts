"use client";

/**
 * React interface to server-backed profile sync.
 *
 * Mirrors `useGoogleDriveSync` so components can treat the two backends
 * alike. Audio still comes from Drive, so this hook forwards the Drive token
 * when there is one — a signed-out viewer falls back to the public proxy.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProfileStore } from "@/store/profileStore";
import {
  applyDriveTokenRefresh,
  currentDriveToken,
} from "@/lib/googleDrive/storeToken";
import { applySyncedProfile } from "./applySyncedProfile";
import { mirrorToProfile, syncStatusActions } from "@/store/syncStatusStore";
import {
  applyServerConflictResolution,
  syncServerProfile,
  type DriveAccess,
} from "@/lib/serverSync/sync";
import type { SyncConflictData } from "@/lib/googleDrive/types";
import type { ConflictOrigin, ProfileSyncData } from "@/lib/syncUtils";
import {
  createServerShare,
  deleteServerShare,
  fetchCurrentUser,
  listServerShares,
  ORIGIN_ID,
} from "@/lib/serverSync/api";
import type {
  ItemConflict,
  ServerShare,
  ServerSyncResult,
  ServerSyncStatus,
  ServerUser,
} from "@/lib/serverSync/types";

/**
 * Open an SSE connection for a profile and call `onChange` when the server
 * says it moved. Returns a teardown function.
 *
 * The browser reconnects a dropped EventSource by itself, and the server
 * greets every new connection with the current version, so a reconnect after
 * a missed change still converges.
 */
export function subscribeToProfileChanges(
  serverProfileId: string,
  shareToken: string | null,
  onChange: (version: number) => void,
): () => void {
  // The one place in the app a share token travels in a URL, and the only one
  // where it has to. Both HTTP clients send it as `x-impamp-share-token`
  // precisely so a bearer credential stays out of access logs; `EventSource`
  // sends a URL and the cookies and has no API for a request header, so that
  // is not available here. The cookie alone will not do either: a signed-in
  // link-share holder has no membership row, so `resolveAccess` grants them
  // nothing without the token and the stream would 404 — silently, since
  // `onerror` only logs.
  //
  // So it is a real, accepted cost — the token reaches this app's own access
  // log — rather than an oversight, and it stops here.
  // `serverSync/shareTokenChannel.test.ts` pins the header rule for every call
  // that can honour it, and this exception, together.
  const query = shareToken ? `?token=${encodeURIComponent(shareToken)}` : "";
  const source = new EventSource(
    `/api/profiles/${serverProfileId}/events${query}`,
  );

  // The highest version this device is known to be holding. The server greets
  // every new connection with the current version and forces a reconnect every
  // half hour, so without this each stream re-announced a version it had
  // already reported and triggered a full sync for it.
  //
  // Seeded from the profile rather than starting at zero, because the greeting
  // is news to a *stream* and almost never news to the *device*. Every page
  // load opened a stream per server profile and every one of those greetings
  // ran a full pull and merge for a version already applied — moments after
  // the load-time sync of the same profiles. The push half of that is caught
  // by `describesSameSyncState`, but the whole local profile is read and
  // merged before anything gets as far as deciding not to write.
  //
  // Read here rather than passed in so a caller cannot forget it or hand over
  // a stale one, and it is only ever a floor: an unknown profile, or one that
  // has never pulled, starts at zero exactly as before.
  let reportedVersion =
    useProfileStore
      .getState()
      .profiles.find((p) => p.serverProfileId === serverProfileId)
      ?.serverVersion ?? 0;

  const handler = (event: MessageEvent) => {
    try {
      const change = JSON.parse(event.data) as {
        version: number;
        originId?: string;
      };
      // Our own write comes back to us; syncing on it would be pointless work.
      if (change.originId === ORIGIN_ID) return;
      // A version we have already handled says nothing new.
      if (change.version <= reportedVersion) return;
      reportedVersion = change.version;
      onChange(change.version);
    } catch (error) {
      console.warn("Malformed profile change event:", error);
    }
  };

  source.addEventListener("change", handler as EventListener);
  source.onerror = () => {
    // EventSource retries on its own; log once rather than tearing down.
    console.warn(`Profile event stream interrupted for ${serverProfileId}`);
  };

  return () => {
    source.removeEventListener("change", handler as EventListener);
    source.close();
  };
}

export interface ServerSyncHook {
  serverUser: ServerUser | null;
  isServerSignedIn: boolean;
  isCheckingSession: boolean;
  syncStatus: ServerSyncStatus;
  error: string | null;
  /** Non-fatal problems from the last sync. A sync with warnings still succeeded. */
  warnings: string[];
  conflicts: ItemConflict[];
  /** The three versions behind `conflicts`, for the resolution modal. */
  conflictData: SyncConflictData | null;
  syncProfile: (profileId: number) => Promise<ServerSyncResult>;
  resolveConflict: (
    profileId: number,
    resolvedData: ProfileSyncData,
    origin: Extract<ConflictOrigin, { kind: "server" }>,
  ) => Promise<ServerSyncResult>;
  refreshSession: () => Promise<void>;
  listShares: (serverProfileId: string) => Promise<ServerShare[]>;
  addShare: (
    serverProfileId: string,
    role: "viewer" | "editor",
    email?: string,
  ) => Promise<ServerShare>;
  revokeShare: (serverProfileId: string, shareId: number) => Promise<void>;
}

/**
 * The session lookup is shared across hook instances.
 *
 * `useServerSync` is used by the initializer *and* by every profile card, so
 * without this a profile list of ten cards would fire ten identical
 * `/api/auth/session` requests on mount.
 */
let sessionRequest: Promise<ServerUser | null> | null = null;

/** The Google token the cached answer was fetched under. */
let sessionToken: string | null | undefined;

/**
 * Every mounted instance, so a reload of the session reaches all of them.
 *
 * Without this, `refreshSession` updated only the instance that called it —
 * and `ServerAccountPanel` is the only caller. Signing out of server sync left
 * every profile card still believing it was signed in, so the server option
 * stayed enabled and the SSE streams and scheduled syncs kept firing against a
 * dead cookie until the page was reloaded.
 */
const sessionListeners = new Set<(user: ServerUser | null) => void>();

function loadSession(force: boolean): Promise<ServerUser | null> {
  if (force || !sessionRequest) {
    sessionRequest = fetchCurrentUser()
      .catch((error) => {
        console.warn("Could not check server session:", error);
        return null;
      })
      .then((user) => {
        sessionListeners.forEach((notify) => notify(user));
        return user;
      });
  }
  return sessionRequest;
}

export function useServerSync(): ServerSyncHook {
  const [serverUser, setServerUser] = useState<ServerUser | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [syncStatus, setSyncStatus] = useState<ServerSyncStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<ItemConflict[]>([]);
  const [conflictData, setConflictData] = useState<SyncConflictData | null>(
    null,
  );

  // Re-checked whenever Google auth changes: signing in to Drive also
  // establishes the server session, so that's exactly when one appears.
  const googleAccessToken = useProfileStore((s) => s.googleAccessToken);

  const refreshSession = useCallback(async () => {
    setServerUser(await loadSession(true));
    setIsCheckingSession(false);
  }, []);

  useEffect(() => {
    sessionListeners.add(setServerUser);
    return () => {
      sessionListeners.delete(setServerUser);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A *change* of Google token means sign-in happened, so re-ask rather than
    // reusing the cached answer. Asking whether one merely exists forced a
    // fresh request from every signed-in instance, which is exactly the ten
    // identical requests the shared promise was written to avoid.
    const changed = sessionToken !== googleAccessToken;
    sessionToken = googleAccessToken;
    void loadSession(changed).then((user) => {
      if (cancelled) return;
      setServerUser(user);
      setIsCheckingSession(false);
    });
    return () => {
      cancelled = true;
    };
  }, [googleAccessToken]);

  const callbacks = useMemo(
    () => ({
      onStatusChange: setSyncStatus,
      onError: setError,
      onWarnings: setWarnings,
      onConflictsDetected: setConflicts,
      onConflictDataAvailable: setConflictData,
    }),
    [],
  );

  const sync = useCallback(
    async (profileId: number): Promise<ServerSyncResult> => {
      // Built here rather than during render: the point is to read the Drive
      // token at call time, so a refresh since the last render is picked up.
      // It used to be assembled into a ref during render, which is both the
      // long way round and a write React reserves for effects and handlers.
      const driveAccess: DriveAccess = {
        tokenInfo: currentDriveToken(),
        onTokenRefresh: applyDriveTokenRefresh,
      };

      const result = await syncServerProfile(
        profileId,
        mirrorToProfile(profileId, callbacks, {
          setConflicts,
          setConflictData,
        }),
        driveAccess,
      );

      if (result.status === "success") {
        await applySyncedProfile(profileId);
      }

      return result;
    },
    [callbacks],
  );

  const resolveConflict = useCallback(
    async (
      profileId: number,
      resolvedData: ProfileSyncData,
      origin: Extract<ConflictOrigin, { kind: "server" }>,
    ) => {
      const result = await applyServerConflictResolution(
        profileId,
        resolvedData,
        origin,
      );
      if (result.status === "success") {
        setConflicts([]);
        setConflictData(null);
        syncStatusActions.patch(profileId, {
          conflicts: [],
          conflictData: null,
        });
        setSyncStatus("success");
        setError(null);
        await applySyncedProfile(profileId);
      } else if (result.status === "error") {
        setError(result.error);
      }
      return result;
    },
    [],
  );

  return {
    serverUser,
    isServerSignedIn: serverUser !== null,
    isCheckingSession,
    syncStatus,
    error,
    warnings,
    conflicts,
    conflictData,
    syncProfile: sync,
    resolveConflict,
    refreshSession,
    listShares: listServerShares,
    addShare: createServerShare,
    revokeShare: deleteServerShare,
  };
}
