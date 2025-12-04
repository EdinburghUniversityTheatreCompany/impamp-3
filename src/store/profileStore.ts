import { create } from "zustand";
import { persist } from "zustand/middleware";
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
} from "@/lib/db";
// Import/export utilities will be loaded dynamically to reduce bundle size
// Types are imported separately for type checking
import type { ProfileExport, MultiProfileExport } from "../lib/importExport";
import { convertBankNumberToIndex } from "@/lib/bankUtils";

import { isTokenExpiredOrExpiring, validateAuthState } from "@/lib/authUtils";

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
  fadeoutDuration: number; // Duration in seconds for the fadeout effect
  fetchProfiles: () => Promise<void>;
  setActiveProfileId: (id: number | null) => void;
  setCurrentPageIndex: (bankNumber: number) => void; // Changed param name to bankNumber for clarity
  setEditMode: (isActive: boolean) => void; // Set edit mode
  setDeleteMoveMode: (isActive: boolean) => void; // Set delete/move mode
  toggleDeleteMoveMode: () => void; // Toggle delete/move mode
  incrementEmergencySoundsVersion: () => void; // Increment counter when emergency sounds change
  getFadeoutDuration: () => number; // Get the current fadeout duration
  setFadeoutDuration: (seconds: number) => void; // Set a new fadeout duration
  getActivePadBehavior: () => ActivePadBehavior; // Get the behavior for the active profile
  setActivePadBehavior: (behavior: ActivePadBehavior) => Promise<void>; // Set the behavior for the active profile

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
  exportMultipleProfilesToJSON: (profileIds: number[]) => Promise<boolean>;
  importProfileFromJSON: (jsonData: string) => Promise<number>; // For current format
  importProfileFromImpamp2JSON: (jsonData: string) => Promise<number>; // For impamp2 format
  importMultipleProfilesFromJSON: (
    jsonData: string,
  ) => Promise<{ profileName: string; result: number | Error }[]>;

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
const _triggerDownload = (
  jsonDataString: string,
  filename: string,
): boolean => {
  try {
    const blob = new Blob([jsonDataString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100); // Clean up URL object
    return true;
  } catch (error) {
    console.error("Error triggering download:", error);
    return false;
  }
};
// --- End Helper Function ---

export const useProfileStore = create<ProfileState>()(
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
      fadeoutDuration: 3, // Default fadeout duration in seconds

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
        const profileExists = get().profiles.some((p: Profile) => p.id === id);
        if (id === null || profileExists) {
          set({ activeProfileId: id });
          // TODO: Trigger loading of pad configurations for the new active profile
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

        // Use an IIFE to handle the async operation within the synchronous function signature
        (async () => {
          try {
            const { getAllPageMetadataForProfile } = await import("@/lib/db"); // Dynamic import
            const metadata =
              await getAllPageMetadataForProfile(activeProfileId);
            const existingIndices = new Set(metadata.map((m) => m.pageIndex));

            // Banks 0-9 (UI 1-10) are assumed to always exist conceptually, even if no metadata entry exists yet.
            // Check if the target index exists in metadata OR is within the default range (0-9).
            const bankExists = index <= 9 || existingIndices.has(index);

            if (bankExists) {
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
            // Optionally handle the error, e.g., prevent switching or show a message
            // For now, we'll prevent switching if metadata fetch fails for higher banks
            if (index > 9) {
              console.warn(
                `Could not verify existence of bank ${bankNumber} due to error. Current bank selection maintained.`,
              );
            } else {
              // Allow switching to default banks 1-10 even if metadata fetch fails
              console.log(
                `Switching to default bank ${bankNumber} (internal index: ${index}) despite metadata fetch error.`,
              );
              set({ currentPageIndex: index });
            }
          }
        })();
      },

      setEditMode: (isActive: boolean) => {
        console.log(`Setting edit mode to: ${isActive}`);
        // If enabling edit mode, disable delete/move mode
        if (isActive && get().isDeleteMoveMode) {
          set({ isEditMode: isActive, isDeleteMoveMode: false });
        } else {
          set({ isEditMode: isActive });
        }
      },

      setDeleteMoveMode: (isActive: boolean) => {
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

      incrementEmergencySoundsVersion: () => {
        console.log(
          "Emergency sounds configuration changed, incrementing version",
        );
        set((state) => ({
          emergencySoundsVersion: state.emergencySoundsVersion + 1,
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
      exportMultipleProfilesToJSON: async (profileIds: number[]) => {
        if (!profileIds || profileIds.length === 0) {
          console.warn("No profile IDs provided for multi-export.");
          return false;
        }
        try {
          // Dynamically import the export functions to reduce bundle size
          const { exportMultipleProfiles } =
            await import("../lib/importExport");
          const exportData = await exportMultipleProfiles(profileIds);

          // Convert to JSON string
          const jsonString = JSON.stringify(exportData, null, 2);

          // Create filename
          const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
          let filename: string;
          if (profileIds.length === 1) {
            // Try to get the single profile name for a more specific filename
            const profile = get().profiles.find((p) => p.id === profileIds[0]);
            const profileName = profile?.name || "profile";
            const sanitizedName = profileName
              .replace(/[^a-z0-9]/gi, "-")
              .toLowerCase();
            filename = `impamp-${sanitizedName}-${date}.json`;
          } else {
            filename = `impamp-multi-profile-export-${profileIds.length}-profiles-${date}.json`;
          }

          // Use helper to trigger download
          const success = _triggerDownload(jsonString, filename);

          // --- Update lastBackedUpAt timestamp for all exported profiles ---
          if (success) {
            console.log(
              `Successfully triggered download for ${profileIds.length} profiles. Now updating timestamps...`,
            );
            const nowMs = Date.now();
            try {
              // Update DB for all profiles
              const updateDbPromises = profileIds.map((id) =>
                updateProfile(id, { lastBackedUpAt: nowMs }),
              );
              await Promise.all(updateDbPromises);

              // Update state for all profiles
              set((state) => ({
                profiles: state.profiles.map((p) =>
                  profileIds.includes(p.id!) // Check if this profile was exported
                    ? {
                        ...p,
                        lastBackedUpAt: nowMs,
                        updatedAt: new Date(nowMs),
                      }
                    : p,
                ),
              }));
              console.log(
                `Successfully updated lastBackedUpAt for ${profileIds.length} profiles in DB and state.`,
              );
            } catch (updateError) {
              console.error(
                `Failed to update lastBackedUpAt for one or more profiles (${profileIds.join(", ")}) after successful export:`,
                updateError,
              );
              // Set error state, but don't throw, as download succeeded
              set({
                error: `Profiles exported, but failed to update backup timestamp: ${updateError instanceof Error ? updateError.message : "Unknown error"}`,
              });
            }
          } else {
            console.error(
              `Failed to trigger download for ${profileIds.length} profiles.`,
            );
            set({ error: `Failed to trigger download for profile export.` });
          }
          // --- End timestamp update ---

          return success;
        } catch (error) {
          console.error("Failed to export multiple profiles:", error);
          const errorMessage =
            error instanceof Error
              ? error.message
              : "An unknown error occurred";
          set({ error: `Failed to export profiles: ${errorMessage}` });
          throw error; // Re-throw for UI handling
        }
      },

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
          const { importImpamp2Profile } = await import("../lib/importExport");
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
          await updateProfile(activeProfileId, { activePadBehavior: behavior });

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
          googleRefreshToken: refreshToken,
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
        const { googleAccessToken, googleRefreshToken, tokenExpiresAt } = get();

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
);
