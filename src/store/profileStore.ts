import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Profile,
  SyncType,
  getAllProfiles,
  ensureDefaultProfile,
  addProfile,
  updateProfile,
  deleteProfile,
  getProfile,
} from '@/lib/db';
import {
  exportProfile,
  importProfile,
  importImpamp2Profile,
  ProfileExport,
} from '../lib/importExport';
import { convertBankNumberToIndex } from '@/lib/bankUtils';

interface ProfileState {
  profiles: Profile[];
  activeProfileId: number | null;
  currentPageIndex: number;  // Track the current bank/page (internal index 0-19)
  isEditMode: boolean;      // Track if we're in edit mode (shift key)
  isLoading: boolean;
  error: string | null;
  isProfileManagerOpen: boolean; // Track if profile manager modal is open
  emergencySoundsVersion: number;  // Track changes to emergency sounds configuration
  fadeoutDuration: number;   // Duration in seconds for the fadeout effect
  fetchProfiles: () => Promise<void>;
  setActiveProfileId: (id: number | null) => void;
  setCurrentPageIndex: (bankNumber: number) => void;  // Changed param name to bankNumber for clarity
  setEditMode: (isActive: boolean) => void;      // Toggle edit mode
  incrementEmergencySoundsVersion: () => void;   // Increment counter when emergency sounds change
  getFadeoutDuration: () => number;              // Get the current fadeout duration
  setFadeoutDuration: (seconds: number) => void; // Set a new fadeout duration

  // Profile management actions
  createProfile: (profile: { name: string, syncType: SyncType }) => Promise<number>;
  updateProfile: (id: number, updates: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteProfile: (id: number) => Promise<void>;

  // Import/Export functionality
  exportProfileToJSON: (profileId: number) => Promise<boolean>;
  importProfileFromJSON: (jsonData: string) => Promise<number>; // For current format
  importProfileFromImpamp2JSON: (jsonData: string) => Promise<number>; // For impamp2 format

  // Profile manager UI state
  openProfileManager: () => void;
  closeProfileManager: () => void;
}

export const useProfileStore = create<ProfileState>()(
  persist( // Wrap the store definition with persist
    (set, get) => ({
      // Store definition starts here
      profiles: [],
      activeProfileId: null,
      currentPageIndex: 0,  // Default to first bank (displayed as bank 1)
      isEditMode: false,    // Default to not in edit mode
      isLoading: true,
      error: null,
      isProfileManagerOpen: false, // Profile manager modal is closed by default
      emergencySoundsVersion: 0,  // Initial version for emergency sounds tracking
      fadeoutDuration: 3,   // Default fadeout duration in seconds

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
          const activeProfileExists = profiles.some((p: Profile) => p.id === currentActiveId);

          if (!currentActiveId || !activeProfileExists) {
            const defaultProfile = profiles.find((p: Profile) => p.name === 'Default Local Profile');
            const firstProfileId = defaultProfile?.id ?? profiles[0]?.id ?? null;
            // Only set if activeProfileId is still null after hydration attempt
            if (get().activeProfileId === null) {
                set({ activeProfileId: firstProfileId });
                console.log(`Setting active profile to: ${firstProfileId}`);
            }
          }

        } catch (err) {
          console.error("Failed to fetch profiles:", err);
          const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
          set({ error: `Failed to load profiles: ${errorMessage}`, isLoading: false });
        }
      },

      setActiveProfileId: (id: number | null) => {
        console.log(`Attempting to set active profile ID to: ${id}`);
        const profileExists = get().profiles.some((p: Profile) => p.id === id);
        if (id === null || profileExists) {
          set({ activeProfileId: id });
          // TODO: Trigger loading of pad configurations for the new active profile
        } else {
            console.warn(`Profile with ID ${id} not found in the store. Active profile not changed.`);
        }
      },

      setCurrentPageIndex: (bankNumber: number) => {
        // Convert bank number to internal index using the imported utility function
        const index = convertBankNumberToIndex(bankNumber);

        // First check if index is within valid bounds (0-19 for 20 banks)
        if (index < 0 || index >= 20) {
          console.warn(`Invalid bank number: ${bankNumber}. Must be 1-9, 0 (for bank 10), or 11-20.`);
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
            const { getAllPageMetadataForProfile } = await import('@/lib/db'); // Dynamic import
            const metadata = await getAllPageMetadataForProfile(activeProfileId);
            const existingIndices = new Set(metadata.map(m => m.pageIndex));

            // Banks 0-9 (UI 1-10) are assumed to always exist conceptually, even if no metadata entry exists yet.
            // Check if the target index exists in metadata OR is within the default range (0-9).
            const bankExists = index <= 9 || existingIndices.has(index);

            if (bankExists) {
              console.log(`Switching to bank ${bankNumber} (internal index: ${index})`);
              set({ currentPageIndex: index });
            } else {
              console.warn(`Bank ${bankNumber} (internal index: ${index}) does not exist for profile ${activeProfileId}. Current bank selection maintained.`);
              // Don't change the current index - maintain the current bank selection
            }
          } catch (error) {
            console.error(`Error fetching page metadata while switching bank:`, error);
            // Optionally handle the error, e.g., prevent switching or show a message
            // For now, we'll prevent switching if metadata fetch fails for higher banks
            if (index > 9) {
               console.warn(`Could not verify existence of bank ${bankNumber} due to error. Current bank selection maintained.`);
            } else {
               // Allow switching to default banks 1-10 even if metadata fetch fails
               console.log(`Switching to default bank ${bankNumber} (internal index: ${index}) despite metadata fetch error.`);
               set({ currentPageIndex: index });
            }
          }
        })();
      },

      setEditMode: (isActive: boolean) => {
        console.log(`Setting edit mode to: ${isActive}`);
        set({ isEditMode: isActive });
      },

      incrementEmergencySoundsVersion: () => {
        console.log('Emergency sounds configuration changed, incrementing version');
        set((state) => ({ emergencySoundsVersion: state.emergencySoundsVersion + 1 }));
      },

      // Profile management actions
      createProfile: async (profileData) => {
        try {
          const newProfileId = await addProfile(profileData);
          // Fetch the newly created profile to add it to the state
          const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
          if (newProfile) {
            set((state) => ({
              profiles: [...state.profiles, newProfile]
            }));
          } else {
            // Fallback to fetching all if getting the specific one fails
            console.warn(`Could not fetch new profile ${newProfileId}, falling back to fetchProfiles`);
            await get().fetchProfiles();
          }
          return newProfileId;
        } catch (error) {
          console.error('Failed to create profile:', error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          set({ error: `Failed to create profile: ${errorMessage}` });
          throw error;
        }
      },

      updateProfile: async (id, updates) => {
        try {
          await updateProfile(id, updates);
          // Update profile in state directly
          set((state) => ({
            profiles: state.profiles.map(p =>
              p.id === id
                ? { ...p, ...updates, updatedAt: new Date() } // Apply updates and new timestamp
                : p
            )
          }));
        } catch (error) {
          console.error(`Failed to update profile ${id}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          set({ error: `Failed to update profile: ${errorMessage}` });
          throw error;
        }
      },

      deleteProfile: async (id) => {
        if (id === get().activeProfileId) {
          throw new Error('Cannot delete the active profile. Please switch to another profile first.');
        }

        try {
          await deleteProfile(id);
          // Remove profile from state directly
          set((state) => ({
            profiles: state.profiles.filter(p => p.id !== id)
          }));
          // Removed: await get().fetchProfiles();
        } catch (error) {
          console.error(`Failed to delete profile ${id}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          set({ error: `Failed to delete profile: ${errorMessage}` });
          throw error;
        }
      },

      // Import/Export functionality
      exportProfileToJSON: async (profileId: number) => {
        try {
          const exportData = await exportProfile(profileId);

          // Convert to JSON string
          const jsonString = JSON.stringify(exportData, null, 2);

          // Get profile name for filename
          const profile = get().profiles.find((p: Profile) => p.id === profileId); // Added type
          const profileName = profile?.name || 'profile';
          const sanitizedName = profileName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
          const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

          // Create download
          const blob = new Blob([jsonString], { type: 'application/json' });
          const url = URL.createObjectURL(blob);

          // Create a link and trigger download
          const a = document.createElement('a');
          a.href = url;
          a.download = `impamp-${sanitizedName}-${date}.json`;
          document.body.appendChild(a);
          a.click();

          // Clean up
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 100);

          return true;
        } catch (error) {
          console.error('Failed to export profile:', error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          set({ error: `Failed to export profile: ${errorMessage}` });
          throw error;
        }
      },

      importProfileFromJSON: async (jsonData: string) => {
        try {
          // Parse the JSON data
          let importData: ProfileExport;
          try {
            importData = JSON.parse(jsonData) as ProfileExport;
          } catch {
            throw new Error('Invalid JSON format');
          }

          // Validate the import data structure
          if (!importData.exportVersion ||
              !importData.profile ||
              !Array.isArray(importData.padConfigurations) ||
              !Array.isArray(importData.pageMetadata) ||
              !Array.isArray(importData.audioFiles)) {
            throw new Error('Invalid profile export format');
          }

          // Import the profile
          // Need to pass the db instance now
          const { getDb } = await import('@/lib/db'); // Import getDb dynamically
          const db = await getDb();
          const newProfileId = await importProfile(db, importData);

          // Add the newly imported profile to the state
          const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
          if (newProfile) {
            set((state) => ({
              profiles: [...state.profiles, newProfile]
            }));
          } else {
             // Fallback to fetching all if getting the specific one fails
            console.warn(`Could not fetch imported profile ${newProfileId}, falling back to fetchProfiles`);
            await get().fetchProfiles();
          }

          return newProfileId;
        } catch (error) {
          console.error('Failed to import profile:', error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
          set({ error: `Failed to import profile: ${errorMessage}` });
          throw error;
        }
      },

      importProfileFromImpamp2JSON: async (jsonData: string) => {
        try {
          // Call the specific impamp2 import function from importExport.ts
          // Need to pass the db instance now
          const { getDb } = await import('@/lib/db'); // Import getDb dynamically
          const db = await getDb();
          const newProfileId = await importImpamp2Profile(db, jsonData);

          // Add the newly imported profile to the state
          const newProfile = await getProfile(newProfileId); // Use statically imported getProfile
           if (newProfile) {
            set((state) => ({
              profiles: [...state.profiles, newProfile]
            }));
          } else {
             // Fallback to fetching all if getting the specific one fails
            console.warn(`Could not fetch imported impamp2 profile ${newProfileId}, falling back to fetchProfiles`);
            await get().fetchProfiles();
          }

          return newProfileId;
        } catch (error) {
          console.error('Failed to import impamp2 profile:', error);
          const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
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
          console.warn('Fadeout duration must be positive, ignoring invalid value:', seconds);
          return;
        }
        // Update state (persist middleware handles saving)
        set({ fadeoutDuration: seconds });
      },
    }),
    {
      name: 'impamp-profile-storage', // Name for localStorage key
      partialize: (state) => ({
        activeProfileId: state.activeProfileId,
        fadeoutDuration: state.fadeoutDuration
      }), // Only persist these parts of the state
    }
  )
);

// REMOVED: Initial fetch of profiles. This will be handled by ClientSideInitializer.
// useProfileStore.getState().fetchProfiles();
