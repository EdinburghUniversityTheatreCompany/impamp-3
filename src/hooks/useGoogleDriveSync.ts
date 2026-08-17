"use client";

/**
 * React hook for Google Drive synchronization
 * Provides an interface for components to interact with Google Drive
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useProfileStore } from "@/store/profileStore";
import { applySyncedProfile } from "./applySyncedProfile";
import { mirrorToProfile } from "@/store/syncStatusStore";

// Import from our modular structure
import {
  DriveFile,
  ProfileSyncData,
  SyncStatus,
  SyncConflictData,
  TokenInfo,
  ItemConflict,
  SyncResult,
} from "@/lib/googleDrive/types";
import { isTokenValid } from "@/lib/googleDrive/utils";
import { checkAndRefreshAuth } from "@/lib/googleDrive/auth";
import {
  findDriveFileById,
  findDriveFileByName,
  getDriveFileVersionToken,
  listAppFiles,
  listFilesInFolder,
  downloadDriveFile,
  uploadDriveFile,
  createFilePermission,
  downloadAudioFileAsBlob,
  listFolderPermissions,
  setPublicLinkAccess,
  inviteUser,
  removePermission,
} from "@/lib/googleDrive/api";
import type { DrivePermission } from "@/lib/googleDrive/types";
import {
  syncProfile,
  applyConflictResolution,
  uploadMissingAudioFiles,
  repairDriveAudioFiles,
} from "@/lib/googleDrive/sync";
import { getLocalProfileSyncData } from "@/lib/googleDrive/dataAccess";
import { getProfileSyncFilename } from "@/lib/googleDrive/utils";

// API type declarations for consistent return type
type SyncProfileFn = (profileId: number) => Promise<SyncResult>;
type ApplyConflictResolutionFn = (
  resolvedData: ProfileSyncData,
  fileId: string,
  profileId: number,
) => Promise<SyncResult>;
type ListAppFilesFn = () => Promise<DriveFile[]>;
type ListFilesInFolderFn = (folderId: string) => Promise<DriveFile[]>;
type DownloadDriveFileFn = (fileId: string) => Promise<ProfileSyncData | null>;
type UploadDriveFileFn = (
  fileName: string,
  jsonData: ProfileSyncData,
  existingFileId: string | null,
  profileId: number,
) => Promise<DriveFile>;
type FindDriveFileByIdFn = (fileId: string) => Promise<DriveFile | null>;
type FindDriveFileByNameFn = (fileName: string) => Promise<DriveFile | null>;
type ShareDriveFileFn = (fileId: string) => Promise<void>;
type DownloadAudioFileFn = (driveFileId: string) => Promise<Blob | null>;
type GetRemoteVersionTokenFn = (fileId: string) => Promise<string | null>;
type UploadMissingAudioFilesFn = (profileId: number) => Promise<void>;
type RepairDriveAudioFn = (
  profileId: number,
  folderId?: string,
) => Promise<{ checked: number; uploaded: number; errors: string[] }>;
type ListFolderPermissionsFn = (folderId: string) => Promise<DrivePermission[]>;
type SetPublicLinkAccessFn = (
  folderId: string,
  access: "off" | "reader" | "writer",
) => Promise<void>;
type InviteUserFn = (
  folderId: string,
  email: string,
  role: "reader" | "writer",
) => Promise<DrivePermission>;
type RemovePermissionFn = (
  folderId: string,
  permissionId: string,
) => Promise<void>;

// Hook return type interface
interface GoogleDriveSyncHookReturn {
  syncStatus: SyncStatus;
  error: string | null;
  conflicts: ItemConflict[];
  conflictData: SyncConflictData | null;
  syncProfile: SyncProfileFn;
  applyConflictResolution: ApplyConflictResolutionFn;
  listAppFiles: ListAppFilesFn;
  listFilesInFolder: ListFilesInFolderFn;
  downloadDriveFile: DownloadDriveFileFn;
  downloadAudioFile: DownloadAudioFileFn;
  getRemoteVersionToken: GetRemoteVersionTokenFn;
  uploadDriveFile: UploadDriveFileFn;
  findDriveFileById: FindDriveFileByIdFn;
  findDriveFileByName: FindDriveFileByNameFn;
  shareDriveFile: ShareDriveFileFn;
  uploadMissingAudioFiles: UploadMissingAudioFilesFn;
  listFolderPermissions: ListFolderPermissionsFn;
  setPublicLinkAccess: SetPublicLinkAccessFn;
  inviteUser: InviteUserFn;
  removePermission: RemovePermissionFn;
  repairDriveAudio: RepairDriveAudioFn;
}

/**
 * Token validation is shared across every instance of this hook.
 *
 * `useGoogleDriveSync` is mounted by ClientSideInitializer, ProfileManager,
 * every ProfileCard, ProfileSyncPanel, SharingPanel, ConnectProfileList,
 * useConnectServerProfile and both share-link pages — so with the profile
 * manager open on ten profiles there are a dozen live instances. The throttle
 * and the refresh were per instance, so an expired token produced up to a
 * dozen simultaneous `POST /api/auth/google/refresh` calls, each finishing by
 * writing its result to the store, last writer winning.
 *
 * `useServerSync` already solves exactly this with a module-level in-flight
 * promise and a listener set; this is the same shape.
 */
let lastRefreshAttempt = 0;
let refreshInFlight: ReturnType<typeof checkAndRefreshAuth> | null = null;

/** Refreshes at most once at a time, whichever instance asks. */
function sharedCheckAndRefresh(
  tokenInfo: Parameters<typeof checkAndRefreshAuth>[0],
): ReturnType<typeof checkAndRefreshAuth> {
  refreshInFlight ??= checkAndRefreshAuth(tokenInfo).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Test seam: forget the shared throttle between cases. */
export function resetGoogleTokenRefreshState(): void {
  lastRefreshAttempt = 0;
  refreshInFlight = null;
}

/**
 * React hook for Google Drive synchronization
 * @returns API for interacting with Google Drive sync functionality
 */
export const useGoogleDriveSync = (): GoogleDriveSyncHookReturn => {
  // State hooks for sync operations
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ItemConflict[]>([]);
  const [conflictData, setConflictData] = useState<SyncConflictData | null>(
    null,
  );

  // State ref to prevent recreation on each render
  const stateRef = useRef({
    syncStatus,
    error,
    conflicts,
    conflictData,
    needsReauthSet: false, // Track if we've already set needsReauth
  });

  // Update ref when state changes
  useEffect(() => {
    stateRef.current = {
      ...stateRef.current,
      syncStatus,
      error,
      conflicts,
      conflictData,
    };
  }, [syncStatus, error, conflicts, conflictData]);

  // Define user info type
  interface GoogleUserInfo {
    email?: string;
    name?: string;
    picture?: string;
  }

  // Use local state for storing auth values from the Zustand store
  const [authState, setAuthState] = useState({
    googleAccessToken: null as string | null,
    googleRefreshToken: null as string | null,
    tokenExpiresAt: null as number | null,
    isGoogleSignedIn: false,
    needsReauth: false,
    googleUser: null as GoogleUserInfo | null,
  });

  // Type for the auth state selector
  interface AuthStateSelector {
    googleAccessToken: string | null;
    googleRefreshToken: string | null;
    tokenExpiresAt: number | null;
    isGoogleSignedIn: boolean;
    needsReauth: boolean;
    googleUser: GoogleUserInfo | null;
  }

  // Type for Zustand store to avoid any
  interface ProfileState {
    googleAccessToken: string | null;
    googleRefreshToken: string | null;
    tokenExpiresAt: number | null;
    isGoogleSignedIn: boolean;
    needsReauth: boolean;
    googleUser: GoogleUserInfo | null;
    setGoogleAuthDetails: (
      userInfo: GoogleUserInfo,
      accessToken: string,
      refreshToken: string | null,
      expiresAt: number | null,
    ) => void;
  }

  // Memoize the selector to prevent unnecessary re-renders
  const selectAuthState = useCallback(
    (state: ProfileState): AuthStateSelector => ({
      googleAccessToken: state.googleAccessToken,
      googleRefreshToken: state.googleRefreshToken,
      tokenExpiresAt: state.tokenExpiresAt,
      isGoogleSignedIn: state.isGoogleSignedIn,
      needsReauth: state.needsReauth,
      googleUser: state.googleUser,
    }),
    [],
  );

  // Mirror the store's auth slice into React state.
  //
  // Selector-based (see subscribeWithSelector in profileStore), so the
  // listener is woken only when one of these six fields changes rather than on
  // every store mutation, and the hand-rolled six-way equality check that used
  // to guard against re-rendering the whole app goes with it. setAuthState is
  // passed as the subscription callback rather than called in the effect body,
  // which is the shape React wants for syncing with an external store.
  useEffect(
    () =>
      useProfileStore.subscribe(selectAuthState, setAuthState, {
        equalityFn: (a, b) =>
          a.googleAccessToken === b.googleAccessToken &&
          a.googleRefreshToken === b.googleRefreshToken &&
          a.tokenExpiresAt === b.tokenExpiresAt &&
          a.isGoogleSignedIn === b.isGoogleSignedIn &&
          a.needsReauth === b.needsReauth &&
          a.googleUser === b.googleUser,
        fireImmediately: true,
      }),
    [selectAuthState],
  );

  // Prepare token info based on local state
  const currentTokenInfo = useMemo<TokenInfo | null>(() => {
    if (!authState.isGoogleSignedIn || !authState.googleAccessToken)
      return null;

    return {
      accessToken: authState.googleAccessToken,
      refreshToken: authState.googleRefreshToken,
      expiresAt: authState.tokenExpiresAt || 0,
    };
  }, [
    authState.isGoogleSignedIn,
    authState.googleAccessToken,
    authState.googleRefreshToken,
    authState.tokenExpiresAt,
  ]);

  // Read token fresh from the store at call-time to avoid stale closures.
  // Callbacks that pass tokenInfo to async functions should use this instead
  // of the closure-captured currentTokenInfo, because React may call the effect
  // with the old callback before currentTokenInfo has been updated.
  const getFreshTokenInfo = useCallback((): TokenInfo | null => {
    const s = useProfileStore.getState();
    if (!s.isGoogleSignedIn || !s.googleAccessToken) return null;
    return {
      accessToken: s.googleAccessToken,
      refreshToken: s.googleRefreshToken,
      expiresAt: s.tokenExpiresAt || 0,
    };
  }, []);

  // Reset the needsReauthSet flag when needsReauth changes to false
  useEffect(() => {
    if (!authState.needsReauth) {
      stateRef.current.needsReauthSet = false;
    }
  }, [authState.needsReauth]);

  // Get setGoogleAuthDetails function from the store
  const setGoogleAuthDetails = useProfileStore(
    (state) => state.setGoogleAuthDetails,
  );

  // Token refresh callback
  const handleTokenRefresh = useCallback(
    (newTokenInfo: TokenInfo) => {
      if (!newTokenInfo.accessToken) return;

      // Keep the existing user info when refreshing tokens
      setGoogleAuthDetails(
        authState.googleUser || { name: "", email: "" }, // Preserve existing user info or use minimal object
        newTokenInfo.accessToken,
        newTokenInfo.refreshToken || null,
        newTokenInfo.expiresAt,
      );

      // Reset the needsReauth flag directly - won't cause a loop because we check for changes in useEffect
      useProfileStore.setState({ needsReauth: false });

      console.log("Token refreshed successfully", {
        expiresAt: new Date(newTokenInfo.expiresAt).toLocaleString(),
      });
    },
    [setGoogleAuthDetails, authState.googleUser],
  );

  // Check token validity on mount and periodically. An expired token is only a
  // re-auth prompt once refreshing it has actually failed.
  useEffect(() => {
    // Skip if not signed in or no token
    if (!authState.isGoogleSignedIn || !currentTokenInfo) return;

    // Skip if we already know we need reauth
    if (authState.needsReauth) return;

    let cancelled = false;

    const validateToken = async () => {
      const tokenInfo = getFreshTokenInfo();
      if (!tokenInfo || stateRef.current.needsReauthSet) return;
      if (isTokenValid(tokenInfo.accessToken, tokenInfo.expiresAt)) return;

      // Offline: the refresh can't succeed and the token isn't necessarily bad
      if (typeof navigator !== "undefined" && navigator.onLine === false)
        return;

      // Each refresh updates the store, which re-runs this effect — don't let
      // a short-lived token turn that into a refresh loop
      // Module-level, so a dozen mounted instances share one throttle rather
      // than each keeping its own and all firing at once.
      const now = Date.now();
      if (now - lastRefreshAttempt < 60 * 1000) return;
      lastRefreshAttempt = now;

      const { isValid, refreshedTokenInfo } =
        await sharedCheckAndRefresh(tokenInfo);
      if (cancelled) return;

      if (isValid) {
        if (refreshedTokenInfo) handleTokenRefresh(refreshedTokenInfo);
        return;
      }

      console.log("Token expired and refresh failed - needs re-authentication");
      stateRef.current.needsReauthSet = true;
      useProfileStore.setState({ needsReauth: true });
    };

    // Run initial validation
    void validateToken();

    // Set up interval for periodic checks
    const intervalId = setInterval(() => void validateToken(), 5 * 60 * 1000); // Check every 5 minutes

    // Cleanup function
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [
    authState.isGoogleSignedIn,
    authState.needsReauth,
    currentTokenInfo,
    getFreshTokenInfo,
    handleTokenRefresh,
  ]);

  // Status callbacks
  const callbacks = useMemo(
    () => ({
      onStatusChange: setSyncStatus,
      onError: setError,
      onConflictsDetected: setConflicts,
      onConflictDataAvailable: setConflictData,
    }),
    [],
  );

  // API Implementation functions
  const synchronizeProfile = useCallback(
    async (profileId: number): Promise<SyncResult> => {
      const result = await syncProfile(
        profileId,
        getFreshTokenInfo(),
        mirrorToProfile(profileId, callbacks, {
          setConflicts,
          setConflictData,
        }),
        handleTokenRefresh,
      );
      if (result.status === "success") {
        await applySyncedProfile(profileId);
      }
      return result;
    },
    [getFreshTokenInfo, callbacks, handleTokenRefresh],
  );

  const resolveConflict = useCallback(
    async (
      resolvedData: ProfileSyncData,
      fileId: string,
      profileId: number,
    ): Promise<SyncResult> => {
      return await applyConflictResolution(
        resolvedData,
        fileId,
        profileId,
        getFreshTokenInfo(),
        // Mirrored, exactly as `synchronizeProfile` above is. The raw
        // `callbacks` object has no `onWarnings` at all — it is optional on
        // `SyncStatusCallbacks` — so a warning raised while applying a hand-made
        // resolution went nowhere: not to the panel, not to the store, and the
        // user was told the resolution had succeeded. The mirror is what
        // supplies that channel; passing the raw object was the whole bug.
        mirrorToProfile(profileId, callbacks, {
          setConflicts,
          setConflictData,
        }),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, callbacks, handleTokenRefresh],
  );

  const getAppFiles = useCallback(async (): Promise<DriveFile[]> => {
    return await listAppFiles(getFreshTokenInfo(), handleTokenRefresh);
  }, [getFreshTokenInfo, handleTokenRefresh]);

  const getFilesInFolder = useCallback(
    async (folderId: string): Promise<DriveFile[]> => {
      return await listFilesInFolder(
        folderId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const downloadFile = useCallback(
    async (fileId: string): Promise<ProfileSyncData | null> => {
      return await downloadDriveFile(
        fileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const getVersionToken = useCallback(
    async (fileId: string): Promise<string | null> => {
      return await getDriveFileVersionToken(
        fileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const uploadFile = useCallback(
    async (
      fileName: string,
      jsonData: ProfileSyncData,
      existingFileId: string | null,
      profileId: number,
    ): Promise<DriveFile> => {
      return await uploadDriveFile(
        fileName,
        jsonData,
        existingFileId,
        profileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const findFileById = useCallback(
    async (fileId: string): Promise<DriveFile | null> => {
      return await findDriveFileById(
        fileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const findFileByName = useCallback(
    async (fileName: string): Promise<DriveFile | null> => {
      return await findDriveFileByName(
        fileName,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const shareFile = useCallback(
    async (fileId: string): Promise<void> => {
      return await createFilePermission(
        fileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const downloadAudio = useCallback(
    async (driveFileId: string): Promise<Blob | null> => {
      return await downloadAudioFileAsBlob(
        driveFileId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const uploadMissingAudio = useCallback(
    async (profileId: number): Promise<void> => {
      const tokenInfo = getFreshTokenInfo();
      if (!tokenInfo) throw new Error("Not authenticated with Google Drive");
      return await uploadMissingAudioFiles(
        profileId,
        tokenInfo,
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const repairAudio = useCallback(
    async (
      profileId: number,
      folderId?: string,
    ): Promise<{ checked: number; uploaded: number; errors: string[] }> => {
      const tokenInfo = getFreshTokenInfo();
      if (!tokenInfo) throw new Error("Not authenticated with Google Drive");
      return repairDriveAudioFiles(
        profileId,
        tokenInfo,
        handleTokenRefresh,
        folderId,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const listPermissions = useCallback(
    async (folderId: string): Promise<DrivePermission[]> => {
      return await listFolderPermissions(
        folderId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const setPublicAccess = useCallback(
    async (
      folderId: string,
      access: "off" | "reader" | "writer",
    ): Promise<void> => {
      return await setPublicLinkAccess(
        folderId,
        access,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const invite = useCallback(
    async (
      folderId: string,
      email: string,
      role: "reader" | "writer",
    ): Promise<DrivePermission> => {
      return await inviteUser(
        folderId,
        email,
        role,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  const removePerm = useCallback(
    async (folderId: string, permissionId: string): Promise<void> => {
      return await removePermission(
        folderId,
        permissionId,
        getFreshTokenInfo(),
        handleTokenRefresh,
      );
    },
    [getFreshTokenInfo, handleTokenRefresh],
  );

  // Return the hook API
  return {
    syncStatus,
    error,
    conflicts,
    conflictData,
    syncProfile: synchronizeProfile,
    applyConflictResolution: resolveConflict,
    listAppFiles: getAppFiles,
    listFilesInFolder: getFilesInFolder,
    downloadDriveFile: downloadFile,
    downloadAudioFile: downloadAudio,
    getRemoteVersionToken: getVersionToken,
    uploadDriveFile: uploadFile,
    findDriveFileById: findFileById,
    findDriveFileByName: findFileByName,
    shareDriveFile: shareFile,
    uploadMissingAudioFiles: uploadMissingAudio,
    listFolderPermissions: listPermissions,
    setPublicLinkAccess: setPublicAccess,
    inviteUser: invite,
    removePermission: removePerm,
    repairDriveAudio: repairAudio,
  };
};

// Re-export utility functions for use by other components
export { getProfileSyncFilename, getLocalProfileSyncData };
