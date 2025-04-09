import { create } from 'zustand';
import { 
  Profile, 
  SyncType, 
  getAllProfiles, 
  ensureDefaultProfile, 
  addProfile, 
  updateProfile, 
  deleteProfile,
  exportProfile,
  importProfile,
  ProfileExport
} from '@/lib/db';

interface ProfileState {
  profiles: Profile[];
  activeProfileId: number | null;
  currentPageIndex: number;  // Track the current bank/page (internal index 0-19)
  isEditMode: boolean;      // Track if we're in edit mode (shift key)
  isEditing: boolean;       // Track if we're currently in the middle of editing something
  isLoading: boolean;
  error: string | null;
  isProfileManagerOpen: boolean; // Track if profile manager modal is open
  emergencySoundsVersion: number;  // Track changes to emergency sounds configuration
  fetchProfiles: () => Promise<void>;
  setActiveProfileId: (id: number | null) => void;
  setCurrentPageIndex: (bankNumber: number) => void;  // Changed param name to bankNumber for clarity
  setEditMode: (isActive: boolean) => void;      // Toggle edit mode
  setEditing: (isActive: boolean) => void;       // Toggle editing state
  incrementEmergencySoundsVersion: () => void;   // Increment counter when emergency sounds change
  convertBankNumberToIndex: (bankNumber: number) => number; // Convert from UI bank number to internal index
  convertIndexToBankNumber: (index: number) => number;     // Convert from internal index to UI bank number
  
  // Profile management actions
  createProfile: (profile: { name: string, syncType: SyncType }) => Promise<number>;
  updateProfile: (id: number, updates: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>;
  deleteProfile: (id: number) => Promise<void>;
  
  // Import/Export functionality
  exportProfileToJSON: (profileId: number) => Promise<boolean>;
  importProfileFromJSON: (jsonData: string) => Promise<number>;
  
  // Profile manager UI state
  openProfileManager: () => void;
  closeProfileManager: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  currentPageIndex: 0,  // Default to first bank (displayed as bank 1)
  isEditMode: false,    // Default to not in edit mode
  isEditing: false,     // Default to not currently editing
  isLoading: true,
  error: null,
  isProfileManagerOpen: false, // Profile manager modal is closed by default
  emergencySoundsVersion: 0,  // Initial version for emergency sounds tracking

  fetchProfiles: async () => {
    set({ isLoading: true, error: null });
    try {
      // Ensure the default profile exists before fetching
      await ensureDefaultProfile();
      const profiles = await getAllProfiles();
      set({ profiles, isLoading: false });

      // Check for a saved profile ID in localStorage
      const savedProfileId = localStorage.getItem('impamp-activeProfileId');
      const savedId = savedProfileId ? parseInt(savedProfileId, 10) : null;
      
      // If we have a saved ID and it exists in our profiles, use it
      if (savedId && profiles.some(p => p.id === savedId)) {
        set({ activeProfileId: savedId });
        console.log(`Restored active profile from localStorage: ${savedId}`);
        return;
      }
      
      // If no active profile is set, or the active one is no longer valid,
      // set the first profile as active (preferring the default if it exists)
      const currentActiveId = get().activeProfileId;
      const activeProfileExists = profiles.some(p => p.id === currentActiveId);

      if (!currentActiveId || !activeProfileExists) {
        const defaultProfile = profiles.find(p => p.name === 'Default Local Profile');
        const firstProfileId = defaultProfile?.id ?? profiles[0]?.id ?? null;
        set({ activeProfileId: firstProfileId });
        console.log(`Setting active profile to: ${firstProfileId}`);
      }

    } catch (err) {
      console.error("Failed to fetch profiles:", err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      set({ error: `Failed to load profiles: ${errorMessage}`, isLoading: false });
    }
  },

  setActiveProfileId: (id: number | null) => {
    console.log(`Attempting to set active profile ID to: ${id}`);
    const profileExists = get().profiles.some(p => p.id === id);
    if (id === null || profileExists) {
      set({ activeProfileId: id });
      
      // Save the active profile ID to localStorage for persistence
      if (id !== null) {
        localStorage.setItem('impamp-activeProfileId', id.toString());
        console.log(`Active profile ID set to: ${id} and saved to localStorage`);
      } else {
        localStorage.removeItem('impamp-activeProfileId');
        console.log('Active profile ID cleared from localStorage');
      }
      
      // TODO: Trigger loading of pad configurations for the new active profile
    } else {
        console.warn(`Profile with ID ${id} not found in the store. Active profile not changed.`);
    }
  },
  
  // Convert from UI bank number (1-20) to internal index (0-19)
  convertBankNumberToIndex: (bankNumber: number) => {
    // Map bank 10 to internal index 9, and banks 11-20 to indices 10-19
    if (bankNumber === 0) return 9; // 0 key maps to bank 10 (index 9)
    if (bankNumber >= 1 && bankNumber <= 9) return bankNumber - 1; // Banks 1-9 map to indices 0-8
    if (bankNumber >= 11 && bankNumber <= 20) return bankNumber - 1; // Banks 11-20 map to indices 10-19
    return -1; // Invalid bank number
  },
  
  // Convert from internal index (0-19) to UI bank number (1-20)
  convertIndexToBankNumber: (index: number) => {
    if (index >= 0 && index <= 8) return index + 1; // Indices 0-8 map to banks 1-9
    if (index === 9) return 10; // Index 9 maps to bank 10
    if (index >= 10 && index <= 19) return index + 1; // Indices 10-19 map to banks 11-20
    return -1; // Invalid index
  },
  
  setCurrentPageIndex: (bankNumber: number) => {
    // Convert bank number to internal index
    const index = get().convertBankNumberToIndex(bankNumber);
    
    // Ensure index is within valid bounds (0-19 for 20 banks)
    if (index >= 0 && index < 20) {
      console.log(`Switching to bank ${bankNumber} (internal index: ${index})`);
      set({ currentPageIndex: index });
    } else {
      console.warn(`Invalid bank number: ${bankNumber}. Must be 1-9, 0 (for bank 10), or 11-20.`);
    }
  },

  setEditMode: (isActive: boolean) => {
    console.log(`Setting edit mode to: ${isActive}`);
    set({ isEditMode: isActive });
    
    // If we're exiting edit mode, also exit editing state
    if (!isActive) {
      set({ isEditing: false });
    }
  },
  
  setEditing: (isActive: boolean) => {
    console.log(`Setting editing state to: ${isActive}`);
    set({ isEditing: isActive });
  },
  
  incrementEmergencySoundsVersion: () => {
    console.log('Emergency sounds configuration changed, incrementing version');
    set((state) => ({ emergencySoundsVersion: state.emergencySoundsVersion + 1 }));
  },
  
  // Profile management actions
  createProfile: async (profile) => {
    try {
      const id = await addProfile(profile);
      await get().fetchProfiles(); // Refresh profiles list
      return id;
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
      await get().fetchProfiles(); // Refresh profiles list
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
      await get().fetchProfiles(); // Refresh profiles list
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
      const profile = get().profiles.find(p => p.id === profileId);
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
      } catch (error) {
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
      const newProfileId = await importProfile(importData);
      
      // Refresh the profiles list
      await get().fetchProfiles();
      
      return newProfileId;
    } catch (error) {
      console.error('Failed to import profile:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      set({ error: `Failed to import profile: ${errorMessage}` });
      throw error;
    }
  },
  
  // Profile manager UI state
  openProfileManager: () => set({ isProfileManagerOpen: true }),
  closeProfileManager: () => set({ isProfileManagerOpen: false }),
}));

// Initial fetch of profiles when the store is initialized
// This ensures data is loaded when the app starts
useProfileStore.getState().fetchProfiles();
