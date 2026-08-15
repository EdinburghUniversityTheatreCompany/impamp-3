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
import type { TokenInfo } from "@/lib/googleDrive/types";
import { applySyncedProfile } from "./applySyncedProfile";
import { syncStatusActions } from "@/store/syncStatusStore";
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
  const query = shareToken ? `?token=${encodeURIComponent(shareToken)}` : "";
  const source = new EventSource(
    `/api/profiles/${serverProfileId}/events${query}`,
  );

  const handler = (event: MessageEvent) => {
    try {
      const change = JSON.parse(event.data) as {
        version: number;
        originId?: string;
      };
      // Our own write comes back to us; syncing on it would be pointless work.
      if (change.originId === ORIGIN_ID) return;
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

function loadSession(force: boolean): Promise<ServerUser | null> {
  if (force || !sessionRequest) {
    sessionRequest = fetchCurrentUser().catch((error) => {
      console.warn("Could not check server session:", error);
      return null;
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
    let cancelled = false;
    // A change of Google token means sign-in happened, so re-ask rather than
    // reusing the cached answer.
    void loadSession(googleAccessToken !== null).then((user) => {
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
        onTokenRefresh: (token: TokenInfo) => {
          const store = useProfileStore.getState();
          store.setGoogleAuthDetails(
            store.googleUser ?? { name: "", email: "" },
            token.accessToken,
            token.refreshToken ?? null,
            token.expiresAt,
          );
        },
      };

      const result = await syncServerProfile(
        profileId,
        {
          ...callbacks,
          // Bound to *this* profile so a conflict found by the scheduled sync
          // reaches the card, which holds a different hook instance.
          onConflictsDetected: (conflicts) => {
            setConflicts(conflicts);
            syncStatusActions.patch(profileId, { conflicts });
          },
          onConflictDataAvailable: (conflictData) => {
            setConflictData(conflictData);
            syncStatusActions.patch(profileId, { conflictData });
          },
        },
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

function currentDriveToken(): TokenInfo | null {
  const state = useProfileStore.getState();
  if (!state.isGoogleSignedIn || !state.googleAccessToken) return null;
  return {
    accessToken: state.googleAccessToken,
    refreshToken: state.googleRefreshToken,
    expiresAt: state.tokenExpiresAt || 0,
  };
}
