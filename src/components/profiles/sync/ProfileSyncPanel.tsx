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

import { useProfileSync } from "@/hooks/useProfileSync";
import type { Profile } from "@/lib/db";
import SharingPanel from "@/components/profiles/SharingPanel";
import ServerSharingPanel from "@/components/profiles/ServerSharingPanel";
import SyncAxes from "./SyncAxes";
import SyncControls from "./SyncControls";
import SyncDefectBanner from "./SyncDefectBanner";

export default function ProfileSyncPanel({ profile }: { profile: Profile }) {
  const { state, status, availability, syncNow, pause, resume } =
    useProfileSync(profile);

  // Sharing the profile and sharing its sounds are separate grants, and a
  // server-synced profile with Drive audio genuinely needs both. Putting them
  // side by side is what turns ServerSharingPanel's footnote — "keep the
  // profile's Drive folder shared as well" — from an instruction into a
  // control.
  const showServerSharing =
    state.target === "server" &&
    !state.readOnly &&
    Boolean(profile.serverProfileId);
  const showDriveSharing =
    state.audio === "googleDrive" &&
    !state.readOnly &&
    Boolean(profile.googleDriveFolderId && profile.googleDriveFileId);

  return (
    <div
      data-testid="profile-sync-panel"
      className="mt-3 space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700"
    >
      <SyncDefectBanner defects={state.defects} />

      <SyncAxes state={state} availability={availability} />

      {state.isViewerOfSomeoneElses && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          You have view-only access, so your edits stay on this device.
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
