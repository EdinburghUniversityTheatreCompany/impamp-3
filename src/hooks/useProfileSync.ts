"use client";

/**
 * One view of a profile's syncing, whichever backend it uses.
 *
 * `ProfileCard` used to thread six separate pieces of hook state into its JSX
 * — two sync statuses, two errors, a conflict list, and two sign-in flags —
 * and branch on them in four places. That is most of why it grew to eight
 * hundred lines, and why the two backends drifted: Drive got a status line, a
 * manual sync, a pause and an unlink, and server sync got none of them,
 * because nothing forced the two to be described the same way.
 *
 * This hook is that forcing function. A component asks for a profile and gets
 * its state, its status, and the actions available on it, without knowing
 * which backend is behind them.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile } from "@/lib/db";
import { getSyncState, type SyncState } from "@/lib/syncState";
import { getSyncTimestamp } from "@/lib/googleDrive/utils";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { useServerSync } from "@/hooks/useServerSync";
import { useProfileStore } from "@/store/profileStore";
import {
  useProfileSyncStatus,
  syncStatusActions,
  type ProfileSyncStatus,
} from "@/store/syncStatusStore";
import { canHostAudio } from "@/lib/serverAudio/transfer";
import { clearAudioFileDriveIds } from "@/lib/db";
import { ensureProfileDriveFolder } from "@/lib/googleDrive/sync";
import { deleteServerProfile } from "@/lib/serverSync/api";
import {
  planTransition,
  type SyncDestination,
  type TransitionPlan,
} from "@/lib/syncTransitions";
import { applyTransition, type TransitionOutcome } from "@/lib/applyTransition";
import type { TokenInfo } from "@/lib/googleDrive/types";

/**
 * Whether something is possible, and — the part that was missing — why not.
 *
 * The old UI simply did not render the server-sync button when signed out, so
 * the capability was invisible: nothing told you server sync existed, let
 * alone what to do to get it. An option you can see and cannot use is more
 * honest than an option that isn't there.
 */
export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface ProfileSyncView {
  state: SyncState;
  status: ProfileSyncStatus;
  /** When this profile last synced, or null if it never has. */
  lastSyncedAt: number | null;
  availability: {
    google: Availability;
    server: Availability;
    hostedAudio: Availability;
  };
  /** Sync now, using whichever backend this profile is on. */
  syncNow: () => Promise<void>;
  pause: (durationMs: number) => Promise<void>;
  resume: () => Promise<void>;
  /**
   * What moving this profile to `dest` would do — including whether it is
   * allowed, and what the user should be told before it happens.
   *
   * Separate from `commit` so the confirmation lives in the component that
   * owns the dialog, and the decision stays pure and testable.
   */
  planChange: (dest: SyncDestination) => TransitionPlan;
  commit: (
    plan: TransitionPlan,
    confirmDeleteServerProfile: () => Promise<boolean>,
  ) => Promise<TransitionOutcome>;
}

/**
 * Frozen and shared so each answer keeps one identity across renders — a fresh
 * object per render would defeat every memo downstream.
 */
const AVAILABLE: Availability = Object.freeze({ ok: true });
const CHECKING: Availability = Object.freeze({
  ok: false,
  reason: "Checking…",
});
const NEEDS_GOOGLE: Availability = Object.freeze({
  ok: false,
  reason: "Sign in with Google to use Drive sync.",
});
const NEEDS_SERVER: Availability = Object.freeze({
  ok: false,
  reason: "Sign in with Google to use server sync — one sign-in covers both.",
});
const HOSTING_UNKNOWN: Availability = Object.freeze({
  ok: false,
  reason: "Sign in to see whether this server can host your sounds.",
});
const HOSTING_NOT_APPROVED: Availability = Object.freeze({
  ok: false,
  reason:
    "This server does not host audio for your account. Ask an admin, or keep your sounds in Drive.",
});

export function useProfileSync(profile: Profile): ProfileSyncView {
  const profileId = profile.id;

  const {
    syncProfile: syncDriveProfile,
    syncStatus: driveStatus,
    error: driveError,
  } = useGoogleDriveSync();
  const {
    syncProfile: syncServerProfile,
    isServerSignedIn,
    isCheckingSession,
    serverUser,
  } = useServerSync();

  const isGoogleSignedIn = useProfileStore((s) => s.isGoogleSignedIn);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const pauseSync = useProfileStore((s) => s.pauseSync);
  const resumeSync = useProfileStore((s) => s.resumeSync);

  const status = useProfileSyncStatus(profileId);
  const state = useMemo(() => getSyncState(profile), [profile]);

  // Drive's status still lives in its own hook instance, so mirror it into the
  // shared store for the profile this view is about. Both backends then report
  // through one place, which is what lets a card show a sync it did not start.
  useEffect(() => {
    if (profileId === undefined || state.target !== "googleDrive") return;
    // A mounting instance starts at idle/null, and writing that would erase a
    // failure the user was reading, or one a background sync had just
    // recorded. Only report something this instance actually saw.
    if (driveStatus === "idle" && driveError === null) return;
    syncStatusActions.patch(profileId, {
      activity: driveStatus,
      error: driveError,
    });
  }, [profileId, state.target, driveStatus, driveError]);

  const hostedAudio = useHostedAudioAvailability(
    isServerSignedIn,
    serverUser?.email ?? null,
  );

  const availability = useMemo(
    () => ({
      google: isGoogleSignedIn ? AVAILABLE : NEEDS_GOOGLE,
      server: isCheckingSession
        ? CHECKING
        : isServerSignedIn
          ? AVAILABLE
          : NEEDS_SERVER,
      hostedAudio,
    }),
    [isGoogleSignedIn, isServerSignedIn, isCheckingSession, hostedAudio],
  );

  const syncNow = useCallback(async () => {
    if (profileId === undefined) return;
    syncStatusActions.patch(profileId, { activity: "syncing", error: null });
    try {
      if (state.target === "server") {
        const result = await syncServerProfile(profileId);
        if (result.status === "error") {
          syncStatusActions.patch(profileId, {
            activity: "error",
            error: result.error,
          });
        } else if (result.status === "conflict") {
          // A sync that ended in a conflict has not synced. Recording it as a
          // success would stamp a "synced just now" the profile has not
          // earned, and hide the one state that needs the user.
          syncStatusActions.patch(profileId, { activity: "conflict" });
        } else if (result.status === "skipped") {
          // Nor has one that never ran. "Not a server-synced profile" and
          // "paused until 4pm" were both landing as "Synced just now", with
          // the reason thrown away — so pausing in one tab and pressing Sync
          // now in another reported a sync that had not happened.
          syncStatusActions.patch(profileId, {
            activity: "idle",
            error: result.reason,
          });
        } else {
          syncStatusActions.noteSynced(profileId, Date.now());
          // Attached to the run that produced them. They used to be collected
          // in the server hook and read by nobody, so a sound that could not
          // be uploaded was never mentioned, while warnings left by an earlier
          // transition stayed pinned under every later clean sync.
          syncStatusActions.patch(profileId, {
            warnings: "warnings" in result ? (result.warnings ?? []) : [],
          });
        }
      } else if (state.target === "googleDrive") {
        // The Drive hook reports through its own callbacks, mirrored above.
        await syncDriveProfile(profileId);
      }
    } catch (error) {
      syncStatusActions.patch(profileId, {
        activity: "error",
        error: error instanceof Error ? error.message : "Sync failed.",
      });
    }
  }, [profileId, state.target, syncServerProfile, syncDriveProfile]);

  const pause = useCallback(
    async (durationMs: number) => {
      if (profileId !== undefined) await pauseSync(profileId, durationMs);
    },
    [profileId, pauseSync],
  );

  const resume = useCallback(async () => {
    if (profileId !== undefined) await resumeSync(profileId);
  }, [profileId, resumeSync]);

  const planChange = useCallback(
    (dest: SyncDestination) => planTransition(profile, dest),
    [profile],
  );

  const commit = useCallback(
    async (
      plan: TransitionPlan,
      confirmDeleteServerProfile: () => Promise<boolean>,
    ) => {
      const outcome = await applyTransition(profile, plan, {
        updateProfile: (id, updates) => updateProfile(id, updates),
        clearAudioDriveIds: clearAudioFileDriveIds,
        ensureDriveFolder: async (id) => {
          const token = currentDriveToken();
          if (!token) {
            throw new Error(
              "Sign in with Google to keep this profile's sounds in Drive.",
            );
          }
          await ensureProfileDriveFolder(
            id,
            profile.name,
            token,
            onDriveTokenRefresh,
          );
        },
        // A transition's whole point is to establish the profile at its new
        // home, so anything short of a completed sync has to fail it. Only
        // "error" used to count, which meant a *paused* profile — or one whose
        // first sync hit a conflict — reported the move as successful while
        // nothing had been published, leaving exactly the
        // `server-awaiting-first-sync` defect the state model exists to name.
        // "unchanged" is a success: the destination already has this profile.
        driveSyncNow: async (id) => {
          const result = await syncDriveProfile(id);
          if (result.status === "error") throw new Error(result.error);
          if (result.status === "paused") {
            throw new Error(
              "Sync is paused for this profile, so it was not published. Resume sync and try again.",
            );
          }
          if (result.status === "skipped") {
            throw new Error(
              "This profile was not published to Drive, so the move did not complete.",
            );
          }
          if (result.status === "conflict") {
            throw new Error(
              "Drive has a conflicting copy of this profile. Resolve it before moving.",
            );
          }
        },
        serverSyncNow: async (id) => {
          const result = await syncServerProfile(id);
          if (result.status === "error") throw new Error(result.error);
          if (result.status === "skipped") {
            throw new Error(
              `This profile was not published to the server, so the move did not complete: ${result.reason}`,
            );
          }
          if (result.status === "conflict") {
            throw new Error(
              "The server has a conflicting copy of this profile. Resolve it before moving.",
            );
          }
        },
        deleteServerProfile,
        confirmDeleteServerProfile,
      });

      if (profileId !== undefined) {
        if (outcome.ok && plan.fieldUpdates.syncType === "local") {
          // Unlinked. Every field of the status — the last sync time, the
          // conflicts, the conflict data — describes a link that no longer
          // exists, and nothing else ever removes an entry from this map.
          syncStatusActions.clear(profileId);
        } else {
          syncStatusActions.patch(profileId, {
            error: outcome.ok ? null : (outcome.error ?? null),
            warnings: outcome.warnings,
          });
        }
      }
      return outcome;
    },
    [profile, profileId, updateProfile, syncDriveProfile, syncServerProfile],
  );

  // The store's timestamp wins when it has one; localStorage holds the record
  // the Drive path writes, and unlike the store it survives a reload.
  const lastSyncedAt =
    status.lastSyncedAt ??
    (profileId !== undefined ? getSyncTimestamp(profileId) || null : null);

  return {
    state,
    status,
    lastSyncedAt,
    availability,
    syncNow,
    pause,
    resume,
    planChange,
    commit,
  };
}

/** The Drive token as it is *now*, not as it was when this hook last rendered. */
function currentDriveToken(): TokenInfo | null {
  const s = useProfileStore.getState();
  if (!s.isGoogleSignedIn || !s.googleAccessToken) return null;
  return {
    accessToken: s.googleAccessToken,
    refreshToken: s.googleRefreshToken,
    expiresAt: s.tokenExpiresAt || 0,
  };
}

function onDriveTokenRefresh(token: TokenInfo): void {
  const store = useProfileStore.getState();
  store.setGoogleAuthDetails(
    store.googleUser ?? { name: "", email: "" },
    token.accessToken,
    token.refreshToken ?? null,
    token.expiresAt,
  );
}

/**
 * Whether this deployment hosts audio and this account may use it.
 *
 * Three gates collapse into one answer: the five `IMPAMP_S3_*` variables
 * (absent, and every route answers 501), the per-account `can_upload_audio`
 * flag, and the quota. `canHostAudio` caches for the session, so asking here
 * costs one request no matter how many profiles are on screen.
 */
function useHostedAudioAvailability(
  isServerSignedIn: boolean,
  /** Whose answer this is. Two accounts get different answers. */
  accountKey: string | null,
): Availability {
  // Only the *answer* is state. The signed-out case is derived below, because
  // storing it would mean writing state synchronously inside an effect for a
  // value that is already a function of the props.
  const [resolved, setResolved] = useState<{
    account: string | null;
    value: Availability;
  } | null>(null);

  useEffect(() => {
    if (!isServerSignedIn) return;

    let cancelled = false;
    void canHostAudio().then((ok) => {
      if (!cancelled) {
        setResolved({
          account: accountKey,
          value: ok ? AVAILABLE : HOSTING_NOT_APPROVED,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isServerSignedIn, accountKey]);

  if (!isServerSignedIn) return HOSTING_UNKNOWN;
  // Whose answer it is, rather than merely whether we have one. An answer kept
  // across an account switch offered hosted audio the new account is not
  // approved for, and the move failed when it was taken.
  return resolved && resolved.account === accountKey
    ? resolved.value
    : CHECKING;
}
