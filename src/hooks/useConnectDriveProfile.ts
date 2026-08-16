"use client";

/**
 * Bring a profile that lives in someone's Google Drive onto this device.
 *
 * The sequence — download, check it is an ImpAmp profile, import it linked to
 * the Drive file it came from — was written out four times: the Drive Picker
 * and the pasted-URL form in `ProfileManager`, the "Open with" page at
 * `/drive/open`, and the connect list. Even the validation and the
 * "no profile file found in the selected folder" message were duplicated word
 * for word.
 *
 * They had drifted in the way that matters. Only `/drive/open` waited for the
 * profile list and refused to import a profile this device already had, so
 * connecting the same folder twice from the profile manager silently produced
 * a duplicate — two local profiles syncing to one Drive file, each overwriting
 * the other.
 *
 * The mirror of `useConnectServerProfile`, deliberately: the two ways in should
 * look the same from the outside.
 *
 * @module hooks/useConnectDriveProfile
 */

import { useCallback } from "react";
import { useProfileStore, whenProfilesLoaded } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import type { ProfileSyncData } from "@/lib/syncUtils";
import type { ImportAudioProgress } from "@/lib/importExport";

export type ConnectDriveOutcome =
  | { kind: "connected"; localProfileId: number; name: string }
  | { kind: "already-connected"; name: string };

export interface ConnectDriveOptions {
  /** The remote is not ours to write to. */
  readOnly?: boolean;
  /** Receive changes but never send any. */
  followOnly?: boolean;
  onProgress?: (progress: ImportAudioProgress) => void;
}

/** The shape every connect path validates before writing anything. */
export function isDriveProfileData(
  data: ProfileSyncData | null,
): data is ProfileSyncData {
  return Boolean(data && data._syncFormatVersion === 1 && data.profile);
}

export function useConnectDriveProfile() {
  const importProfileFromSyncData = useProfileStore(
    (s) => s.importProfileFromSyncData,
  );
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const { downloadDriveFile, downloadAudioFile, listFilesInFolder } =
    useGoogleDriveSync();

  /**
   * Imports already-downloaded profile data, linked to where it came from.
   *
   * The one place the "have we got this already?" check lives, so no caller
   * can forget it.
   */
  const connectWithSyncData = useCallback(
    async (
      syncData: ProfileSyncData | null,
      link: { googleDriveFileId: string; googleDriveFolderId?: string },
      options: ConnectDriveOptions = {},
    ): Promise<ConnectDriveOutcome> => {
      if (!isDriveProfileData(syncData)) {
        throw new Error("Not a valid ImpAmp profile file.");
      }

      // Wait for the initial load before deciding: a caller can run before it
      // finishes, and an empty list then reads as "not connected yet" and
      // imports a second copy of the profile.
      const loaded = await whenProfilesLoaded();
      const existing = loaded.find(
        (p) => p.googleDriveFileId === link.googleDriveFileId,
      );
      if (existing) {
        return { kind: "already-connected", name: existing.name };
      }

      const localProfileId = await importProfileFromSyncData(
        syncData,
        downloadAudioFile,
        options.onProgress,
        {
          syncType: "googleDrive",
          audioLocation: "googleDrive",
          googleDriveFileId: link.googleDriveFileId,
          googleDriveFolderId: link.googleDriveFolderId,
        },
      );

      if (options.readOnly || options.followOnly) {
        await updateProfile(localProfileId, {
          readOnly: options.readOnly || undefined,
          followOnly: options.followOnly || undefined,
        });
      }

      return {
        kind: "connected",
        localProfileId,
        name: syncData.profile.name,
      };
    },
    [importProfileFromSyncData, downloadAudioFile, updateProfile],
  );

  const connectByFileId = useCallback(
    async (fileId: string, options: ConnectDriveOptions = {}) =>
      connectWithSyncData(
        await downloadDriveFile(fileId),
        { googleDriveFileId: fileId },
        options,
      ),
    [connectWithSyncData, downloadDriveFile],
  );

  const connectByFolderId = useCallback(
    async (folderId: string, options: ConnectDriveOptions = {}) => {
      const files = await listFilesInFolder(folderId);
      const profileFile = files.find((f) => f.name.endsWith(".json"));
      if (!profileFile) {
        throw new Error(
          "No profile file found in the selected folder. Make sure you're selecting an ImpAmp profile folder.",
        );
      }

      return connectWithSyncData(
        await downloadDriveFile(profileFile.id),
        {
          googleDriveFileId: profileFile.id,
          // The shared folder is what we are connecting to, so it is ours to
          // sync against — unlike a server share link, where the Drive ids in
          // the payload belong to the owner alone.
          googleDriveFolderId: folderId,
        },
        options,
      );
    },
    [connectWithSyncData, downloadDriveFile, listFilesInFolder],
  );

  return { connectByFileId, connectByFolderId, connectWithSyncData };
}
