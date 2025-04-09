import { create } from 'zustand';
import { Profile, getAllProfiles, ensureDefaultProfile } from '@/lib/db';

interface ProfileState {
  profiles: Profile[];
  activeProfileId: number | null;
  currentPageIndex: number;  // Track the current bank/page (internal index 0-19)
  isEditMode: boolean;      // Track if we're in edit mode (shift key)
  isEditing: boolean;       // Track if we're currently in the middle of editing something
  isLoading: boolean;
  error: string | null;
  fetchProfiles: () => Promise<void>;
  setActiveProfileId: (id: number | null) => void;
  setCurrentPageIndex: (bankNumber: number) => void;  // Changed param name to bankNumber for clarity
  setEditMode: (isActive: boolean) => void;      // Toggle edit mode
  setEditing: (isActive: boolean) => void;       // Toggle editing state
  convertBankNumberToIndex: (bankNumber: number) => number; // Convert from UI bank number to internal index
  convertIndexToBankNumber: (index: number) => number;     // Convert from internal index to UI bank number
  // TODO: Add actions for creating, updating, deleting profiles later
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  currentPageIndex: 0,  // Default to first bank (displayed as bank 1)
  isEditMode: false,    // Default to not in edit mode
  isEditing: false,     // Default to not currently editing
  isLoading: true,
  error: null,

  fetchProfiles: async () => {
    set({ isLoading: true, error: null });
    try {
      // Ensure the default profile exists before fetching
      await ensureDefaultProfile();
      const profiles = await getAllProfiles();
      set({ profiles, isLoading: false });

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
      console.log(`Active profile ID set to: ${id}`);
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
}));

// Initial fetch of profiles when the store is initialized
// This ensures data is loaded when the app starts
useProfileStore.getState().fetchProfiles();
