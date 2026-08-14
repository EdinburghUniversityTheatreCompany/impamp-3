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

  const [moving, setMoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

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
    if (Object.keys(plan.fieldUpdates).length === 0) return;

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
    if (availability.google.ok) return "googleDrive";
    if (availability.hostedAudio.ok) return "server";
    return "local";
  }

  return (
    <div
      data-testid="profile-sync-panel"
      className="mt-3 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700"
    >
      <SyncDefectBanner defects={state.defects} />

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

      {state.isViewerOfSomeoneElses && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          You have view-only access, so your edits stay on this device and where
          this syncs is not yours to change.
        </p>
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
