"use client";

/**
 * Bring a profile that lives on the ImpAmp server onto this device.
 *
 * Shared by the two ways in: opening someone's share link, and picking one of
 * your own from the connect list. They differ only in whether a share token is
 * involved — a profile you own or were invited to by email needs none, because
 * the session already proves the grant.
 *
 * The list half had no way in at all until now. `listServerProfiles` existed
 * and was called from nowhere, so signing in on a new device showed you
 * nothing and the only route back to your own profile was a share link,
 * which assumes somebody else is involved.
 */

import { useCallback } from "react";
import { useProfileStore, whenProfilesLoaded } from "@/store/profileStore";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import { fetchServerProfile } from "@/lib/serverSync/api";
import type { ImportAudioProgress } from "@/lib/importExport";

export type ConnectServerOutcome =
  | {
      kind: "connected";
      localProfileId: number;
      name: string;
      readOnly: boolean;
    }
  | { kind: "already-connected"; name: string };

export function useConnectServerProfile() {
  const importProfileFromSyncData = useProfileStore(
    (s) => s.importProfileFromSyncData,
  );
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const { downloadAudioFile } = useGoogleDriveSync();

  return useCallback(
    async (
      serverProfileId: string,
      options: {
        shareToken?: string | null;
        onProgress?: (progress: ImportAudioProgress) => void;
      } = {},
    ): Promise<ConnectServerOutcome> => {
      const shareToken = options.shareToken ?? null;

      // Wait for the initial profile load before deciding: a caller can run
      // before it finishes, and an empty list then reads as "not connected
      // yet" and imports a second copy of the profile.
      const loaded = await whenProfilesLoaded();
      const existing = loaded.find(
        (p) => p.serverProfileId === serverProfileId,
      );
      if (existing) {
        return { kind: "already-connected", name: existing.name };
      }

      const payload = await fetchServerProfile(serverProfileId, {
        shareToken: shareToken ?? undefined,
      });
      if (!payload) {
        // Only a conditional request can 304, and we did not make one.
        throw new Error("The server returned no profile data.");
      }

      const localProfileId = await importProfileFromSyncData(
        payload.data,
        downloadAudioFile,
        options.onProgress,
        // Explicitly *not* the Drive ids the payload carries: they are the
        // owner's. Inheriting them used to make this device try to publish
        // audio into someone else's Drive folder. The sounds arrive by
        // download here.
        { syncType: "server" },
      );

      const readOnly = payload.access === "viewer";
      await updateProfile(localProfileId, {
        serverProfileId,
        serverShareToken: shareToken,
        serverVersion: payload.version,
        serverRole: payload.access,
        readOnly,
      });

      return {
        kind: "connected",
        localProfileId,
        name: payload.name,
        readOnly,
      };
    },
    [importProfileFromSyncData, updateProfile, downloadAudioFile],
  );
}
