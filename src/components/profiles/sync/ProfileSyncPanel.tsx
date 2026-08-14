"use client";

/**
 * Everything about one profile's syncing, in one place.
 *
 * It used to be four conditional blocks in `ProfileCard`, each gated on a
 * different combination of `syncType` and sign-in state, which is how the two
 * backends drifted so far apart: the Drive block grew a status line, a manual
 * sync, a pause and sharing, and the server block stayed three lines of text.
 *
 * Takes only a profile. Everything else comes from `useProfileSync`.
 */

import { useState } from "react";
import { useProfileSync } from "@/hooks/useProfileSync";
import type { AudioLocation, Profile, SyncType } from "@/lib/db";
import { useModal } from "@/hooks/modal/useModal";
import { useProfileStore } from "@/store/profileStore";
import type { SyncDestination } from "@/lib/syncTransitions";
import SharingPanel from "@/components/profiles/SharingPanel";
import ServerSharingPanel from "@/components/profiles/ServerSharingPanel";
import SyncAxes from "./SyncAxes";
import SyncControls from "./SyncControls";
import SyncDefectBanner from "./SyncDefectBanner";

export default function ProfileSyncPanel({ profile }: { profile: Profile }) {
  const {
    state,
    status,
    availability,
    syncNow,
    pause,
    resume,
    planChange,
    commit,
  } = useProfileSync(profile);
  const { openConfirmModal, closeModal } = useModal();
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const fetchProfiles = useProfileStore((s) => s.fetchProfiles);
  const setActiveProfileId = useProfileStore((s) => s.setActiveProfileId);
  const setEditMode = useProfileStore((s) => s.setEditMode);
  const setDeleteMoveMode = useProfileStore((s) => s.setDeleteMoveMode);

  const [moving, setMoving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const setFollowing = async (following: boolean) => {
    if (profile.id === undefined) return;
    await updateProfile(profile.id, { followOnly: following });
    // Editing is refused while following, and a mode left switched on would
    // sit there doing nothing.
    if (following) {
      setEditMode(false);
      setDeleteMoveMode(false);
    }
  };

  /**
   * Fork a profile you cannot change into one you can.
   *
   * Local and unlinked on purpose: it is yours now, and connecting it
   * anywhere is a separate decision made on its own card.
   */
  const makeMyOwnCopy = async () => {
    if (profile.id === undefined) return;
    setCopying(true);
    try {
      const { duplicateProfileLocally } = await import("@/lib/db");
      const copyId = await duplicateProfileLocally(
        profile.id,
        `${profile.name} (my copy)`,
      );
      await fetchProfiles();
      setActiveProfileId(copyId);
    } catch (error) {
      setRefusal(
        error instanceof Error ? error.message : "Could not copy that profile.",
      );
    } finally {
      setCopying(false);
    }
  };

  /**
   * Ask, then move.
   *
   * A refusal is shown rather than silently ignored — "this is shared with
   * you" is information the user needs, and the old UI's answer to an
   * unavailable move was to not render the control at all.
   */
  const move = (dest: SyncDestination) => {
    const plan = planChange(dest);
    setRefusal(null);

    if (!plan.ok) {
      setRefusal(plan.reason ?? "That combination is not possible.");
      return;
    }
    // Effect-only plans are real work — creating a Drive folder writes no
    // fields — so only a plan with neither is nothing to do.
    if (
      Object.keys(plan.fieldUpdates).length === 0 &&
      plan.effects.length === 0
    ) {
      return;
    }

    const run = async () => {
      setMoving(true);
      try {
        await commit(plan, async () =>
          window.confirm(
            "Also delete this profile's copy on the ImpAmp server? Collaborators lose access to it immediately.",
          ),
        );
      } finally {
        setMoving(false);
      }
    };

    // Only a move that gives something up is worth a dialog. Entering a
    // state — "nothing publishes your sounds yet" — is reversible and belongs
    // in the panel afterwards, not in front of the click.
    if (plan.confirmations.length === 0) {
      void run();
      return;
    }

    openConfirmModal({
      title: "Change where this profile syncs",
      message: plan.confirmations.join("\n\n"),
      confirmText: "Move it",
      onConfirm: () => {
        closeModal();
        void run();
      },
      onCancel: closeModal,
    });
  };

  // Sharing the profile and sharing its sounds are separate grants, and a
  // server-synced profile with Drive audio genuinely needs both. Putting them
  // side by side is what turns ServerSharingPanel's note — "keep the profile's
  // Drive folder shared as well" — from an instruction into a control.
  const showServerSharing =
    state.target === "server" &&
    !state.readOnly &&
    Boolean(profile.serverProfileId);
  const showDriveSharing =
    state.audio === "googleDrive" &&
    !state.readOnly &&
    Boolean(profile.googleDriveFolderId && profile.googleDriveFileId);

  /**
   * Where a profile's sounds should go when its *target* changes.
   *
   * Carrying the old answer over is wrong for a profile that has never
   * synced: its sounds are on this device only because there was nowhere else
   * for them to be, not because anyone chose that. An explicit choice is
   * respected; an inferred one gives way to whatever will actually work.
   */
  function defaultAudioFor(target: SyncType): AudioLocation {
    if (target === "local") return "local";
    if (target === "googleDrive") return "googleDrive";
    if (state.audioIsExplicit && state.audio !== "local") return state.audio;
    return bestAudioHome();
  }

  /**
   * Put the sounds somewhere they can reach someone.
   *
   * Not simply a move: when the answer is where they already claim to be —
   * a server profile set to Drive audio with no folder yet, which is the
   * default deployment's shape — the plan writes no fields, and a plan with
   * no fields is a no-op. The work is the effect, so run it directly, and say
   * so when there is nowhere to publish to at all.
   */
  const publishTheSounds = async () => {
    const home = bestAudioHome();
    if (home === "local") {
      setRefusal(
        "There is nowhere to publish these sounds yet. Sign in with Google to use a Drive folder, or ask an admin to let this account store them on the server.",
      );
      return;
    }

    const plan = planChange({ target: state.target, audio: home });
    if (!plan.ok) {
      setRefusal(plan.reason ?? "Those sounds cannot be published from here.");
      return;
    }

    setRefusal(null);
    setMoving(true);
    try {
      await commit(plan, async () => false);
    } finally {
      setMoving(false);
    }
  };

  /** Somewhere the sounds can actually reach other people, if there is one. */
  function bestAudioHome(): AudioLocation {
    if (state.target === "googleDrive") return "googleDrive";
    if (availability.hostedAudio.ok) return "server";
    if (availability.google.ok) return "googleDrive";
    // Nowhere works yet; the transition refuses and says why.
    return "local";
  }

  return (
    <div
      data-testid="profile-sync-panel"
      className="mt-3 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700"
    >
      <SyncDefectBanner defects={state.defects} onFix={publishTheSounds} />

      <SyncAxes
        state={state}
        availability={availability}
        disabled={moving || state.isViewerOfSomeoneElses}
        onChooseTarget={(target: SyncType) =>
          move({ target, audio: defaultAudioFor(target) })
        }
        onChooseAudio={(audio: AudioLocation) =>
          move({ target: state.target, audio })
        }
      />

      {refusal && (
        <p
          data-testid="sync-refusal"
          className="text-xs text-amber-700 dark:text-amber-400"
        >
          {refusal}
        </p>
      )}

      {/*
        Following, and the ways out of it. A profile that cannot push is not
        editable either — the next sync would overwrite the changes — so the
        panel has to offer something better than a dead end.
      */}
      {state.target !== "local" && (
        <div className="space-y-2" data-testid="follow-controls">
          {state.canEdit ? (
            <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
              <input
                type="checkbox"
                checked={state.following}
                onChange={(e) => void setFollowing(e.target.checked)}
                data-testid="follow-toggle"
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  Follow only
                </span>{" "}
                — receive changes but never send any. This profile becomes
                view-only on this device.
              </span>
            </label>
          ) : (
            <p
              data-testid="follow-explainer"
              className="text-xs text-gray-500 dark:text-gray-400"
            >
              {state.following
                ? "You are following this profile: you receive changes and send none, and it cannot be edited here."
                : "You have view-only access, so this profile cannot be edited here — any change would be overwritten by the next sync."}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {state.canUnfollow && (
              <button
                type="button"
                onClick={() => void setFollowing(false)}
                data-testid="unfollow"
                className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-800 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
              >
                Stop following
              </button>
            )}
            {!state.canEdit && (
              <button
                type="button"
                onClick={() => void makeMyOwnCopy()}
                disabled={copying}
                data-testid="make-own-copy"
                className="rounded-md bg-blue-100 px-3 py-1 text-xs text-blue-800 transition-colors hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
              >
                {copying ? "Copying…" : "Make my own copy"}
              </button>
            )}
          </div>
        </div>
      )}

      <SyncControls
        state={state}
        status={status}
        onSyncNow={syncNow}
        onPause={pause}
        onResume={resume}
      />

      {(showServerSharing || showDriveSharing) && (
        <div className="space-y-3">
          {showServerSharing && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-400">
                Who can edit this profile
              </h4>
              <ServerSharingPanel serverProfileId={profile.serverProfileId!} />
            </section>
          )}
          {showDriveSharing && (
            <section>
              <h4 className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-400">
                Who can hear the sounds
              </h4>
              <SharingPanel
                folderId={profile.googleDriveFolderId!}
                profileFileId={profile.googleDriveFileId!}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
