import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import {
  Profile,
  SyncType,
  getAllProfiles,
  ensureDefaultProfile,
  addProfile,
  updateProfile,
  deleteProfile,
  getProfile,
  ActivePadBehavior,
  DEFAULT_NORMALISATION,
  NormalisationSettings,
} from "@/lib/db";
// Import/export utilities will be loaded dynamically to reduce bundle size
// Types are imported separately for type checking
import type {
  ProfileExport,
  MultiProfileExport,
  TransferProgressCallback,
  ZipImportResult,
  ImportAudioProgress,
  ImportLink,
  HostedAudioDownloader,
} from "../lib/importExport";
import type { ProfileSyncData } from "@/lib/syncUtils";
import { convertBankNumberToIndex } from "@/lib/bankUtils";

import { isTokenExpiredOrExpiring, validateAuthState } from "@/lib/authUtils";
import { playbackStoreActions } from "@/store/playbackStore";
import { exposeE2EHook } from "@/lib/testHooks";
import { getSyncState } from "@/lib/syncState";

// Define a type for the decoded Google user info (adjust as needed)
// Export this type so it can be used elsewhere (like in ProfileManager)
export interface GoogleUserInfo {
  email?: string;
  name?: string;
  picture?: string;
  // Add other fields you might need from the decoded token
}

interface ProfileState {
  profiles: Profile[];
  activeProfileId: number | null;
  currentPageIndex: number; // Track the current bank/page (internal index 0-19)
  isEditMode: boolean; // Track if we're in edit mode (shift key)
  isDeleteMoveMode: boolean; // Track if we're in delete and move mode
  isLoading: boolean;
  error: string | null;
  isProfileManagerOpen: boolean; // Track if profile manager modal is open
  emergencySoundsVersion: number; // Track changes to emergency sounds configuration
  padConfigsVersion: number; // Incremented after sync to trigger pad grid refresh
  fadeoutDuration: number; // Duration in seconds for the fadeout effect
  fetchProfiles: () => Promise<void>;
  setActiveProfileId: (id: number | null) => void;
  setCurrentPageIndex: (bankNumber: number) => void; // Changed param name to bankNumber for clarity
  setEditMode: (isActive: boolean) => void; // Set edit mode
  /** False when the active profile is followed, or the remote refuses writes. */
  canEditActiveProfile: () => boolean;
  setDeleteMoveMode: (isActive: boolean) => void; // Set delete/move mode
  toggleDeleteMoveMode: () => void; // Toggle delete/move mode
  incrementEmergencySoundsVersion: () => void; // Increment counter when emergency sounds change
  incrementPadConfigsVersion: () => void; // Increment counter after sync to refresh pad grid
  getFadeoutDuration: () => number; // Get the current fadeout duration
  setFadeoutDuration: (seconds: number) => void; // Set a new fadeout duration
  getActivePadBehavior: () => ActivePadBehavior; // Get the behavior for the active profile
  setActivePadBehavior: (behavior: ActivePadBehavior) => Promise<void>; // Set the behavior for the active profile
  getNormalisationSettings: () => NormalisationSettings; // Get the loudness normalisation settings for the active profile
  setNormalisation: (settings: NormalisationSettings) => Promise<void>; // Set the loudness normalisation settings for the active profile

  // Auto-sync after edits
  syncRequestQueue: Record<number, number>; // profileId → last request timestamp
  requestSync: (profileId: number) => void;

  // Sync pausing methods
  pauseSync: (profileId: number, durationMs: number) => Promise<void>; // Pause sync for a profile
  resumeSync: (profileId: number) => Promise<void>; // Resume sync for a profile
  isSyncPaused: (profileId: number) => boolean; // Check if sync is paused
  getSyncResumeTime: (profileId: number) => number | null; // Get the timestamp when sync will resume

  // Profile management actions
  createProfile: (profile: {
    name: string;
    syncType: SyncType;
  }) => Promise<number>;
  updateProfile: (
    id: number,
    updates: Partial<Omit<Profile, "id" | "createdAt" | "updatedAt">>,
  ) => Promise<void>;
  deleteProfile: (id: number) => Promise<void>;

  // Import/Export functionality
  exportMultipleProfilesToZip: (
    profileIds: number[],
    onProgress?: TransferProgressCallback,
  ) => Promise<boolean>;
  importProfileFromJSON: (jsonData: string) => Promise<number>; // For current format
  importProfileFromImpamp2JSON: (jsonData: string) => Promise<number>; // For impamp2 format
  importMultipleProfilesFromJSON: (
    jsonData: string,
  ) => Promise<{ profileName: string; result: number | Error }[]>;
  importProfilesFromZip: (
    zipBlob: Blob,
    onProgress?: TransferProgressCallback,
  ) => Promise<ZipImportResult[]>;
  importProfileFromSyncData: (
    syncData: ProfileSyncData,
    downloadAudioBlob: (driveFileId: string) => Promise<Blob | null>,
    onProgress?: (progress: ImportAudioProgress) => void,
    link?: ImportLink,
    downloadHostedBlob?: HostedAudioDownloader,
  ) => Promise<number>; // For Drive and server connect flows

  // Profile manager UI state
  openProfileManager: () => void;
  closeProfileManager: () => void;

  // Google Drive Sync State & Actions
  googleUser: GoogleUserInfo | null;
  googleAccessToken: string | null;
  googleRefreshToken: string | null;
  tokenExpiresAt: number | null;
  isGoogleSignedIn: boolean;
  needsReauth: boolean;
  setGoogleAuthDetails: (
    userInfo: GoogleUserInfo,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: number | null,
  ) => void;
  clearGoogleAuthDetails: () => void;
  validateGoogleAuthState: () => Promise<boolean>;
  checkTokenValidity: () => boolean;
}

// --- Private Helper Function ---
// Encapsulates the logic for creating a blob and triggering a download
const _downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
};

const _triggerBlobDownload = (blob: Blob, filename: string): boolean => {
  try {
    _downloadBlob(blob, filename);
    return true;
  } catch (error) {
    console.error("Error triggering blob download:", error);
    return false;
  }
};

// --- End Helper Function ---

// Builds the export filename: the single profile's sanitized name, or a
// generic multi-profile name when exporting more than one at once.
const _buildExportFilename = (
  profileIds: number[],
  profiles: Profile[],
  extension: string,
): string => {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  if (profileIds.length === 1) {
    const profile = profiles.find((p) => p.id === profileIds[0]);
    const profileName = profile?.name || "profile";
    const sanitizedName = profileName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    return `impamp-${sanitizedName}-${date}.${extension}`;
  }
  return `impamp-multi-profile-export-${profileIds.length}-profiles-${date}.${extension}`;
};

// Monotonic token for bank switches, so a slow metadata lookup can never
// overwrite a bank the user selected afterwards.
let pageIndexRequestToken = 0;

type ProfileSetState = (
  partial:
    Partial<ProfileState> | ((state: ProfileState) => Partial<ProfileState>),
) => void;

// Stamps lastBackedUpAt on the given profiles, both in the DB and in store state.
const _markProfilesBackedUpNow = async (
  set: ProfileSetState,
  profileIds: number[],
): Promise<number> => {
  const nowMs = Date.now();
  const updateDbPromises = profileIds.map((id) =>
    updateProfile(id, { lastBackedUpAt: nowMs }),
  );
  await Promise.all(updateDbPromises);

  set((state) => ({
    profiles: state.profiles.map((p) =>
      profileIds.includes(p.id!)
        ? {
            ...p,
            lastBackedUpAt: nowMs,
            updatedAt: new Date(nowMs),
          }
        : p,
    ),
  }));

  return nowMs;
};

// subscribeWithSelector lets a non-React subscriber watch one slice —
// `subscribe(selector, listener)` — instead of being woken by every mutation
// of the store and diffing by hand. ClientSideInitializer alone held four
// whole-store subscriptions doing exactly that.
export const useProfileStore = create<ProfileState>()(
  subscribeWithSelector(
    persist(
      // Wrap the store definition with persist
      (set, get) => ({
        // Store definition starts here
        profiles: [],
        activeProfileId: null,
        currentPageIndex: 0, // Default to first bank (displayed as bank 1)
        isEditMode: false, // Default to not in edit mode
        isDeleteMoveMode: false, // Default to not in delete and move mode
        isLoading: true,
        error: null,
        isProfileManagerOpen: false, // Profile manager modal is closed by default
        emergencySoundsVersion: 0, // Initial version for emergency sounds tracking
        padConfigsVersion: 0,
        fadeoutDuration: 3, // Default fadeout duration in seconds
        syncRequestQueue: {},

        // Google Auth State
        googleUser: null,
        googleAccessToken: null,
        googleRefreshToken: null,
        tokenExpiresAt: null,
        isGoogleSignedIn: false,
        needsReauth: false,

        fetchProfiles: async () => {
          set({ isLoading: true, error: null });
          try {
            // Ensure the default profile exists before fetching
            await ensureDefaultProfile();
            const profiles = await getAllProfiles();
            set({ profiles, isLoading: false });
            // If no active profile is set (after potential hydration), or the active one is no longer valid,
            // set the first profile as active (preferring the default if it exists)
            const currentActiveId = get().activeProfileId; // Get potentially hydrated value
            const activeProfileExists = profiles.some(
              (p: Profile) => p.id === currentActiveId,
            );

            if (!currentActiveId || !activeProfileExists) {
              const defaultProfile = profiles.find(
                (p: Profile) => p.name === "Default Local Profile",
              );
              const firstProfileId =
                defaultProfile?.id ?? profiles[0]?.id ?? null;
              // Only set if activeProfileId is still null after hydration attempt
              if (get().activeProfileId === null) {
                set({ activeProfileId: firstProfileId });
                console.log(`Setting active profile to: ${firstProfileId}`);
              }
            }
          } catch (err) {
            console.error("Failed to fetch profiles:", err);
            const errorMessage =
              err instanceof Error ? err.message : "An unknown error occurred";
            set({
              error: `Failed to load profiles: ${errorMessage}`,
              isLoading: false,
            });
          }
        },

        setActiveProfileId: (id: number | null) => {
          console.log(`Attempting to set active profile ID to: ${id}`);
          const profileExists = get().profiles.some(
            (p: Profile) => p.id === id,
          );
          if (id === null || profileExists) {
            const previousId = get().activeProfileId;
            // Refusing to *enter* a mode is not enough: a mode already latched
            // on an editable profile would otherwise stay on across a switch
            // to one that cannot be edited, leaving its pads fully editable
            // and both banners stacked on top of each other.
            set({
              activeProfileId: id,
              isEditMode: false,
              isDeleteMoveMode: false,
            });
            // Pad configurations are not loaded here: `usePadConfigurations`
            // is keyed on the active profile, so switching it is the trigger.

            // Cues belong to the profile they were armed in. Profiles are
            // isolated, and the Armed Tracks panel shows nothing but a name, so
            // leaving them armed means F9 fires a pad from a profile that is no
            // longer open.
            if (previousId !== id) {
              playbackStoreActions.clearAllArmedTracks();
            }
          } else {
            console.warn(
              `Profile with ID ${id} not found in the store. Active profile not changed.`,
            );
          }
        },

        setCurrentPageIndex: (bankNumber: number) => {
          // Convert bank number to internal index using the imported utility function
          const index = convertBankNumberToIndex(bankNumber);

          // First check if index is within valid bounds (0-19 for 20 banks)
          if (index < 0 || index >= 20) {
            console.warn(
              `Invalid bank number: ${bankNumber}. Must be 1-9, 0 (for bank 10), or 11-20.`,
            );
            return; // Don't change the bank selection
          }

          // Fetch page metadata for the current profile to check if the bank exists
          const activeProfileId = get().activeProfileId;
          if (activeProfileId === null) {
            console.warn("Cannot switch bank, no active profile.");
            return;
          }

          const requestToken = ++pageIndexRequestToken;

          // Banks 0-9 (UI 1-10) always exist conceptually, so switch immediately
          // without waiting on a metadata lookup.
          if (index <= 9) {
            console.log(
              `Switching to bank ${bankNumber} (internal index: ${index})`,
            );
            set({ currentPageIndex: index });
            return;
          }

          // Use an IIFE to handle the async operation within the synchronous function signature
          (async () => {
            try {
              const { getAllPageMetadataForProfile } = await import("@/lib/db"); // Dynamic import
              const metadata =
                await getAllPageMetadataForProfile(activeProfileId);

              // A newer bank switch has been requested in the meantime
              if (requestToken !== pageIndexRequestToken) return;

              const existingIndices = new Set(metadata.map((m) => m.pageIndex));

              if (existingIndices.has(index)) {
                console.log(
                  `Switching to bank ${bankNumber} (internal index: ${index})`,
                );
                set({ currentPageIndex: index });
              } else {
                console.warn(
                  `Bank ${bankNumber} (internal index: ${index}) does not exist for profile ${activeProfileId}. Current bank selection maintained.`,
                );
                // Don't change the current index - maintain the current bank selection
              }
            } catch (error) {
              console.error(
                `Error fetching page metadata while switching bank:`,
                error,
              );
              // We can't verify the bank exists, so keep the current selection
              console.warn(
                `Could not verify existence of bank ${bankNumber} due to error. Current bank selection maintained.`,
              );
            }
          })();
        },

        setEditMode: (isActive: boolean) => {
          if (isActive && !get().canEditActiveProfile()) return;
          console.log(`Setting edit mode to: ${isActive}`);
          // If enabling edit mode, disable delete/move mode
          if (isActive && get().isDeleteMoveMode) {
            set({ isEditMode: isActive, isDeleteMoveMode: false });
          } else {
            set({ isEditMode: isActive });
          }
        },

        setDeleteMoveMode: (isActive: boolean) => {
          if (isActive && !get().canEditActiveProfile()) return;
          console.log(`Setting delete/move mode to: ${isActive}`);
          // If enabling delete/move mode, disable edit mode
          if (isActive && get().isEditMode) {
            set({ isDeleteMoveMode: isActive, isEditMode: false });
          } else {
            set({ isDeleteMoveMode: isActive });
          }
        },

        toggleDeleteMoveMode: () => {
          const currentMode = get().isDeleteMoveMode;
          if (!currentMode && !get().canEditActiveProfile()) return;
          console.log(
            `Toggling delete/move mode from ${currentMode} to ${!currentMode}`,
          );
          const newMode = !currentMode;

          // If enabling delete/move mode, disable edit mode if it's on
          if (newMode && get().isEditMode) {
            set({ isDeleteMoveMode: newMode, isEditMode: false });
          } else {
            set({ isDeleteMoveMode: newMode });
          }
        },

        /**
         * Whether the active profile may be changed at all.
         *
         * Blocked here rather than in each control, because the ways in are
         * the Shift key, two buttons and a hook, and one of them will always
         * be missed. A profile that cannot push does not merely keep your
         * edits private: the next sync applies the merged remote state over
         * them, so they are destroyed. Refusing the edit is the honest answer.
         */
        canEditActiveProfile: () => {
          const { profiles, activeProfileId } = get();
          const active = profiles.find((p) => p.id === activeProfileId);
          return active ? getSyncState(active).canEdit : true;
        },

        incrementPadConfigsVersion: () => {
          set((state) => ({ padConfigsVersion: state.padConfigsVersion + 1 }));
        },

        incrementEmergencySoundsVersion: () => {
          console.log(
            "Emergency sounds configuration changed, incrementing version",
          );
          set((state) => ({
            emergencySoundsVersion: state.emergencySoundsVersion + 1,
          }));
        },

        requestSync: (profileId: number) => {
          set((state) => ({
            syncRequestQueue: {
              ...state.syncRequestQueue,
              [profileId]: Date.now(),
            },
          }));
        },

        // Profile management actions
        createProfile: async (profileData: {
          name: string;
          syncType: SyncType;
        }) => {
          // Keep input type simple
          try {
            // Assert the type when calling addProfile, as it handles defaults
            const newProfileId = await addProfile(
              profileData as Omit<Profile, "id" | "createdAt" | "updatedAt">,
            );
            // Fetch the newly created profile to add it to the state
            const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
            if (newProfile) {
              set((state) => ({
                profiles: [...state.profiles, newProfile],
              }));
            } else {
              // Fallback to fetching all if getting the specific one fails
              console.warn(
                `Could not fetch new profile ${newProfileId}, falling back to fetchProfiles`,
              );
              await get().fetchProfiles();
            }
            return newProfileId;
          } catch (error) {
            console.error("Failed to create profile:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to create profile: ${errorMessage}` });
            throw error;
          }
        },

        updateProfile: async (id, updates) => {
          try {
            await updateProfile(id, updates);
            // Update profile in state directly
            set((state) => ({
              profiles: state.profiles.map((p) =>
                p.id === id
                  ? { ...p, ...updates, updatedAt: new Date() } // Apply updates and new timestamp
                  : p,
              ),
            }));
          } catch (error) {
            console.error(`Failed to update profile ${id}:`, error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to update profile: ${errorMessage}` });
            throw error;
          }
        },

        deleteProfile: async (id) => {
          if (id === get().activeProfileId) {
            throw new Error(
              "Cannot delete the active profile. Please switch to another profile first.",
            );
          }

          try {
            await deleteProfile(id);
            // Remove profile from state directly
            set((state) => ({
              profiles: state.profiles.filter((p) => p.id !== id),
            }));
            // Removed: await get().fetchProfiles();
          } catch (error) {
            console.error(`Failed to delete profile ${id}:`, error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to delete profile: ${errorMessage}` });
            throw error;
          }
        },

        // Import/Export functionality
        importMultipleProfilesFromJSON: async (jsonData: string) => {
          try {
            // Parse the JSON data
            let importData: MultiProfileExport;
            try {
              importData = JSON.parse(jsonData) as MultiProfileExport;
            } catch (parseError) {
              console.error("Failed to parse multi-import JSON:", parseError);
              throw new Error("Invalid JSON format");
            }

            // Basic validation
            if (
              importData.exportVersion !== 1 ||
              !Array.isArray(importData.profiles)
            ) {
              throw new Error(
                "Invalid or unsupported multi-profile export format.",
              );
            }

            // Dynamically import the import functions to reduce bundle size
            const { importMultipleProfiles } =
              await import("../lib/importExport");
            const { getDb } = await import("@/lib/db"); // Import getDb dynamically
            const db = await getDb();
            const results = await importMultipleProfiles(db, importData);

            // Refresh the profiles list in the store after import attempt
            await get().fetchProfiles();

            // Return the detailed results array
            return results;
          } catch (error) {
            console.error("Failed to import multiple profiles:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to import profiles: ${errorMessage}` });
            throw error; // Re-throw for UI handling
          }
        },

        importProfileFromJSON: async (jsonData: string) => {
          try {
            // Parse the JSON data
            let importData: ProfileExport;
            try {
              importData = JSON.parse(jsonData) as ProfileExport;
            } catch {
              throw new Error("Invalid JSON format");
            }

            // Validate the import data structure
            if (
              !importData.exportVersion ||
              !importData.profile ||
              !Array.isArray(importData.padConfigurations) ||
              !Array.isArray(importData.pageMetadata) ||
              !Array.isArray(importData.audioFiles)
            ) {
              throw new Error("Invalid profile export format");
            }

            // Dynamically import the import functions to reduce bundle size
            const { importProfile } = await import("../lib/importExport");
            // Need to pass the db instance now
            const { getDb } = await import("@/lib/db"); // Import getDb dynamically
            const db = await getDb();
            const newProfileId = await importProfile(db, importData);

            // Add the newly imported profile to the state
            const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
            if (newProfile) {
              set((state) => ({
                profiles: [...state.profiles, newProfile],
              }));
            } else {
              // Fallback to fetching all if getting the specific one fails
              console.warn(
                `Could not fetch imported profile ${newProfileId}, falling back to fetchProfiles`,
              );
              await get().fetchProfiles();
            }

            return newProfileId;
          } catch (error) {
            console.error("Failed to import profile:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to import profile: ${errorMessage}` });
            throw error;
          }
        },

        importProfileFromImpamp2JSON: async (jsonData: string) => {
          try {
            // Dynamically import the import functions to reduce bundle size
            const { importImpamp2Profile } =
              await import("../lib/importExport");
            // Need to pass the db instance now
            const { getDb } = await import("@/lib/db"); // Import getDb dynamically
            const db = await getDb();
            const newProfileId = await importImpamp2Profile(db, jsonData);

            // Add the newly imported profile to the state
            const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
            if (newProfile) {
              set((state) => ({
                profiles: [...state.profiles, newProfile],
              }));
            } else {
              // Fallback to fetching all if getting the specific one fails
              console.warn(
                `Could not fetch imported impamp2 profile ${newProfileId}, falling back to fetchProfiles`,
              );
              await get().fetchProfiles();
            }

            return newProfileId;
          } catch (error) {
            console.error("Failed to import impamp2 profile:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to import impamp2 profile: ${errorMessage}` });
            throw error; // Re-throw so the UI can catch it
          }
        },

        exportMultipleProfilesToZip: async (
          profileIds: number[],
          onProgress?: TransferProgressCallback,
        ) => {
          if (!profileIds || profileIds.length === 0) {
            console.warn("No profile IDs provided for ZIP export.");
            return false;
          }
          try {
            const { exportProfilesToZip } = await import("../lib/importExport");

            const filename = _buildExportFilename(
              profileIds,
              get().profiles,
              "iaz",
            );

            // Preferred path: stream the archive straight to disk via the File
            // System Access API (Chromium). The archive never has to fit in
            // memory, so export size is bounded only by free disk space.
            // Note: the picker must be called early, while the button click's
            // user activation is still valid.
            if (typeof window.showSaveFilePicker === "function") {
              let handle: FileSystemFileHandle | null = null;
              try {
                handle = await window.showSaveFilePicker({
                  suggestedName: filename,
                  types: [
                    {
                      description: "ImpAmp profile archive",
                      accept: { "application/zip": [".iaz"] },
                    },
                  ],
                });
              } catch (pickerError) {
                if (
                  pickerError instanceof DOMException &&
                  pickerError.name === "AbortError"
                ) {
                  // User cancelled the save dialog — not an error.
                  return false;
                }
                // Picker unavailable (e.g. blocked in this context) — fall
                // through to the in-memory blob download below.
                console.warn(
                  "Save picker failed, falling back to blob download:",
                  pickerError,
                );
              }

              if (handle) {
                const writable = await handle.createWritable();
                try {
                  await exportProfilesToZip(profileIds, writable, onProgress);
                } catch (error) {
                  try {
                    await writable.abort();
                  } catch {
                    // stream may already be closed
                  }
                  throw error;
                }
                try {
                  await _markProfilesBackedUpNow(set, profileIds);
                } catch (updateError) {
                  set({
                    error: `Profiles exported, but failed to update backup timestamp: ${updateError instanceof Error ? updateError.message : "Unknown error"}`,
                  });
                }
                return true;
              }
            }

            // Fallback: build the archive as an in-memory Blob and download it
            // via an anchor element (browsers without the File System Access
            // API — Firefox/Safari).
            const zipBlob = await exportProfilesToZip(
              profileIds,
              "blob",
              onProgress,
            );
            const success =
              zipBlob !== null && _triggerBlobDownload(zipBlob, filename);

            if (success) {
              try {
                await _markProfilesBackedUpNow(set, profileIds);
              } catch (updateError) {
                set({
                  error: `Profiles exported, but failed to update backup timestamp: ${updateError instanceof Error ? updateError.message : "Unknown error"}`,
                });
              }
            } else {
              set({ error: `Failed to trigger download for profile export.` });
            }

            return success;
          } catch (error) {
            console.error("Failed to export profiles as ZIP:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to export profiles: ${errorMessage}` });
            throw error;
          }
        },

        importProfileFromSyncData: async (
          syncData: ProfileSyncData,
          downloadAudioBlob: (driveFileId: string) => Promise<Blob | null>,
          onProgress?: (progress: ImportAudioProgress) => void,
          link?: ImportLink,
          downloadHostedBlob?: HostedAudioDownloader,
        ) => {
          try {
            const { importProfileFromSyncData } =
              await import("../lib/importExport");
            const { getDb } = await import("@/lib/db");
            const db = await getDb();
            const newProfileId = await importProfileFromSyncData(
              db,
              syncData,
              downloadAudioBlob,
              onProgress,
              link,
              downloadHostedBlob,
            );

            const newProfile = await getProfile(newProfileId);
            if (newProfile) {
              set((state) => ({ profiles: [...state.profiles, newProfile] }));
            } else {
              await get().fetchProfiles();
            }

            return newProfileId;
          } catch (error) {
            console.error("Failed to import profile from sync data:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to connect profile: ${errorMessage}` });
            throw error;
          }
        },

        importProfilesFromZip: async (
          zipBlob: Blob,
          onProgress?: TransferProgressCallback,
        ) => {
          try {
            const { importProfilesFromZip } =
              await import("../lib/importExport");
            const { getDb } = await import("@/lib/db");
            const db = await getDb();
            const results = await importProfilesFromZip(
              zipBlob,
              db,
              onProgress,
            );

            await get().fetchProfiles();

            return results;
          } catch (error) {
            console.error("Failed to import profiles from ZIP:", error);
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to import profiles: ${errorMessage}` });
            throw error;
          }
        },

        // Profile manager UI state
        openProfileManager: () => set({ isProfileManagerOpen: true }),
        closeProfileManager: () => set({ isProfileManagerOpen: false }),

        // Fadeout duration management
        getFadeoutDuration: () => {
          // If we already have a value in state, use it (hydrated by persist)
          const stateValue = get().fadeoutDuration;
          // Fall back to default value (3 seconds) if not hydrated yet by persist middleware
          return stateValue !== undefined ? stateValue : 3;
        },

        setFadeoutDuration: (seconds: number) => {
          if (seconds <= 0) {
            console.warn(
              "Fadeout duration must be positive, ignoring invalid value:",
              seconds,
            );
            return;
          }
          // Update state (persist middleware handles saving)
          set({ fadeoutDuration: seconds });
        },

        getActivePadBehavior: () => {
          const { profiles, activeProfileId } = get();
          const activeProfile = profiles.find((p) => p.id === activeProfileId);
          // Default to 'continue' if profile not found or behavior not set
          return activeProfile?.activePadBehavior || "continue";
        },

        getNormalisationSettings: () => {
          const { profiles, activeProfileId } = get();
          const activeProfile = profiles.find((p) => p.id === activeProfileId);
          return activeProfile?.normalisation ?? DEFAULT_NORMALISATION;
        },

        setActivePadBehavior: async (behavior: ActivePadBehavior) => {
          console.log(
            `[ProfileStore] setActivePadBehavior called with behavior: ${behavior}`,
          ); // Log received value
          const { activeProfileId } = get();
          if (activeProfileId === null) {
            console.warn(
              "Cannot set active pad behavior: No active profile selected.",
            );
            return;
          }

          try {
            // Persist change to DB
            await updateProfile(activeProfileId, {
              activePadBehavior: behavior,
            });

            // Update state
            set((state) => ({
              profiles: state.profiles.map((p) =>
                p.id === activeProfileId
                  ? { ...p, activePadBehavior: behavior, updatedAt: new Date() }
                  : p,
              ),
            }));
            // Log the state *after* update to verify
            const updatedProfile = get().profiles.find(
              (p) => p.id === activeProfileId,
            );
            console.log(
              `[ProfileStore] State updated for profile ${activeProfileId}. New behavior: ${updatedProfile?.activePadBehavior}`,
            );
          } catch (error) {
            console.error(
              `Failed to set activePadBehavior for profile ${activeProfileId}:`,
              error,
            );
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({
              error: `Failed to set active pad behavior: ${errorMessage}`,
            });
            // Re-throw might be useful depending on how calling code handles errors
            // throw error;
          }
        },

        setNormalisation: async (settings: NormalisationSettings) => {
          const { activeProfileId } = get();
          if (activeProfileId === null) {
            console.warn(
              "Cannot set normalisation settings: No active profile selected.",
            );
            return;
          }

          try {
            await updateProfile(activeProfileId, { normalisation: settings });

            set((state) => ({
              profiles: state.profiles.map((p) =>
                p.id === activeProfileId
                  ? { ...p, normalisation: settings, updatedAt: new Date() }
                  : p,
              ),
            }));
          } catch (error) {
            console.error(
              `Failed to set normalisation settings for profile ${activeProfileId}:`,
              error,
            );
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({
              error: `Failed to set normalisation settings: ${errorMessage}`,
            });
          }
        },

        // Google Auth Actions
        setGoogleAuthDetails: (
          userInfo,
          accessToken,
          refreshToken = null,
          expiresAt = null,
        ) => {
          console.log("Setting Google Auth Details:", userInfo);
          set({
            googleUser: userInfo,
            googleAccessToken: accessToken,
            // Google omits the refresh token on re-consent, so keep the existing one
            googleRefreshToken: refreshToken ?? get().googleRefreshToken,
            tokenExpiresAt: expiresAt,
            isGoogleSignedIn: true,
            needsReauth: false,
            error: null, // Clear any previous auth errors
          });
        },

        clearGoogleAuthDetails: () => {
          console.log("Clearing Google Auth Details");
          set({
            googleUser: null,
            googleAccessToken: null,
            googleRefreshToken: null,
            tokenExpiresAt: null,
            isGoogleSignedIn: false,
            needsReauth: false,
          });
        },

        // Check if the current token is valid (not expired)
        checkTokenValidity: () => {
          const { tokenExpiresAt } = get();
          return !isTokenExpiredOrExpiring(tokenExpiresAt);
        },

        // Validate Google auth state and attempt refresh if needed
        validateGoogleAuthState: async () => {
          const { googleAccessToken, googleRefreshToken, tokenExpiresAt } =
            get();

          try {
            const result = await validateAuthState(
              googleAccessToken,
              tokenExpiresAt,
              googleRefreshToken,
            );

            if (result.needsReauth) {
              // Token is expired and can't be refreshed - user needs to sign in again
              set({ needsReauth: true });
              return false;
            }

            if (result.newAccessToken && result.newExpiresAt) {
              // Update with the refreshed token
              set({
                googleAccessToken: result.newAccessToken,
                tokenExpiresAt: result.newExpiresAt,
                needsReauth: false,
              });
            }

            return result.isValid;
          } catch (error) {
            console.error("Error validating Google auth state:", error);
            set({ needsReauth: true });
            return false;
          }
        },

        // Sync pausing methods implementation
        pauseSync: async (profileId: number, durationMs: number) => {
          try {
            const resumeTime = Date.now() + durationMs;
            await updateProfile(profileId, { syncPausedUntil: resumeTime });

            // Update state
            set((state) => ({
              profiles: state.profiles.map((p) =>
                p.id === profileId
                  ? { ...p, syncPausedUntil: resumeTime, updatedAt: new Date() }
                  : p,
              ),
            }));

            console.log(
              `Paused sync for profile ${profileId} until ${new Date(resumeTime).toLocaleString()}`,
            );
          } catch (error) {
            console.error(
              `Failed to pause sync for profile ${profileId}:`,
              error,
            );
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to pause sync: ${errorMessage}` });
            throw error;
          }
        },

        resumeSync: async (profileId: number) => {
          try {
            await updateProfile(profileId, { syncPausedUntil: undefined });

            // Update state
            set((state) => ({
              profiles: state.profiles.map((p) =>
                p.id === profileId
                  ? { ...p, syncPausedUntil: undefined, updatedAt: new Date() }
                  : p,
              ),
            }));

            console.log(`Resumed sync for profile ${profileId}`);
          } catch (error) {
            console.error(
              `Failed to resume sync for profile ${profileId}:`,
              error,
            );
            const errorMessage =
              error instanceof Error
                ? error.message
                : "An unknown error occurred";
            set({ error: `Failed to resume sync: ${errorMessage}` });
            throw error;
          }
        },

        isSyncPaused: (profileId: number) => {
          const profile = get().profiles.find((p) => p.id === profileId);
          if (!profile) return false;

          return (
            profile.syncPausedUntil !== undefined &&
            Date.now() < profile.syncPausedUntil
          );
        },

        getSyncResumeTime: (profileId: number) => {
          const profile = get().profiles.find((p) => p.id === profileId);
          if (!profile || !profile.syncPausedUntil) return null;

          return profile.syncPausedUntil;
        },
      }),
      {
        name: "impamp-profile-storage", // Name for localStorage key
        partialize: (state) => ({
          activeProfileId: state.activeProfileId,
          fadeoutDuration: state.fadeoutDuration,
          googleUser: state.googleUser,
          googleAccessToken: state.googleAccessToken,
          googleRefreshToken: state.googleRefreshToken,
          tokenExpiresAt: state.tokenExpiresAt,
          isGoogleSignedIn: state.isGoogleSignedIn,
          needsReauth: state.needsReauth,
        }),
      },
    ),
  ),
);

exposeE2EHook("__profileStore", useProfileStore);

/**
 * Resolves once the initial profile load has finished.
 *
 * A page can mount before ClientSideInitializer's fetchProfiles() resolves, so
 * a `profiles` list read at that moment is empty and says nothing about what
 * the user actually has. The share-link pages need the real answer before
 * deciding whether a shared profile is already connected — otherwise they
 * import a second copy of it.
 */
export function whenProfilesLoaded(): Promise<Profile[]> {
  const { isLoading, profiles } = useProfileStore.getState();
  if (!isLoading) return Promise.resolve(profiles);

  return new Promise((resolve) => {
    const unsubscribe = useProfileStore.subscribe(
      (state) => state.isLoading,
      (loading) => {
        if (loading) return;
        unsubscribe();
        resolve(useProfileStore.getState().profiles);
      },
    );
  });
}
