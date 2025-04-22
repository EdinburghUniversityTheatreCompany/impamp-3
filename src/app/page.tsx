'use client';

import React, { useEffect, useState, useCallback } from 'react'; // Removed useRef
import dynamic from 'next/dynamic';
import PadGrid from '@/components/PadGrid';
import ActiveTracksPanel from '@/components/ActiveTracksPanel';
import SearchButton from '@/components/SearchButton';
import { useProfileStore } from '@/store/profileStore';
import { useUIStore } from '@/store/uiStore'; // Import UI store
import EditBankModalContent from '@/components/modals/EditBankModalContent'; // Import modal content
import PromptModalContent from '@/components/modals/PromptModalContent'; // Import modal content
import { renamePage, setPageEmergencyState, upsertPageMetadata, getAllPageMetadataForProfile, PageMetadata } from '@/lib/db';

// Pre-load ProfileSelector component to avoid remounting during bank switches
const ProfileSelector = dynamic(() => import('@/components/profiles/ProfileSelector'), {
  ssr: false, 
  loading: () => <div className="w-24 h-10 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse"></div>
});

export default function Home() {
  // Get state and utility functions from profile store
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const currentPageIndex = useProfileStore((state) => state.currentPageIndex);
  const isEditMode = useProfileStore((state) => state.isEditMode);
  const setEditing = useProfileStore((state) => state.setEditing);
  const convertIndexToBankNumber = useProfileStore((state) => state.convertIndexToBankNumber);
  const { openModal, closeModal } = useUIStore(); // Get modal actions
  // Only importing the functions we actually use
  
  // Memoized components to prevent unnecessary remounting
  const renderProfileSelector = useCallback(() => {
    return <ProfileSelector />;
  }, []); // Empty dependency array ensures this doesn't change when banks switch
  
  // State for bank metadata
  const [bankNames, setBankNames] = useState<{[key: number]: string}>({});
  const [emergencyBanks, setEmergencyBanks] = useState<{[key: number]: boolean}>({});
  
  // Load bank metadata when active profile or current page changes
  useEffect(() => {
    if (activeProfileId === null) return;
    
    // Load metadata for all banks
    const loadBankMetadata = async () => {
      const newBankNames: {[key: number]: string} = {};
      const newEmergencyBanks: {[key: number]: boolean} = {};
      
      try {
        // Get all existing page metadata for this profile
        const allMetadata = await getAllPageMetadataForProfile(activeProfileId);
        
        // Process all existing metadata
        allMetadata.forEach((metadata: PageMetadata) => {
          newBankNames[metadata.pageIndex] = metadata.name;
          newEmergencyBanks[metadata.pageIndex] = metadata.isEmergency;
        });
        
        // Ensure we have defaults for banks 1-10 if they don't exist
        // These correspond to internal indices 0-9
        for (let i = 0; i <= 9; i++) {
          if (!newBankNames.hasOwnProperty(i)) {
            const bankNumber = convertIndexToBankNumber(i);
            newBankNames[i] = `Bank ${bankNumber}`;
            newEmergencyBanks[i] = false;
          }
        }
      } catch (error) {
        console.error(`Error loading bank metadata:`, error);
        // Set defaults for banks 1-10 (indices 0-9) in case of error
        for (let i = 0; i <= 9; i++) {
          const bankNumber = convertIndexToBankNumber(i);
          newBankNames[i] = `Bank ${bankNumber}`;
          newEmergencyBanks[i] = false;
        }
      }
      
      setBankNames(newBankNames);
      setEmergencyBanks(newEmergencyBanks);
    };
    
    loadBankMetadata();
  }, [activeProfileId, currentPageIndex, convertIndexToBankNumber]);
  
  // Handle bank click with shift key in edit mode
  const handleBankClick = (bankIndex: number, isShiftClick: boolean) => { // Removed async as modal handles async internally
    if (!isEditMode || !isShiftClick || activeProfileId === null) {
      // Regular bank switch (handled by the button's onClick) - This part remains synchronous
      return;
    }
    
    // In edit mode with shift pressed, show dialog to rename and set emergency flag
    const bankNumber = convertIndexToBankNumber(bankIndex); // Keep only one declaration
    const currentName = bankNames[bankIndex] || `Bank ${bankNumber}`;
    const currentIsEmergency = emergencyBanks[bankIndex] || false;

    // Variable to hold the data from the modal content
    let modalData = { name: currentName, isEmergency: currentIsEmergency };

    // Set editing state to true before opening modal
    setEditing(true);

    openModal({
      title: `Edit Bank ${bankNumber}`,
      content: (
        <EditBankModalContent
          initialName={currentName}
          initialIsEmergency={currentIsEmergency}
          onDataChange={(data) => {
            modalData = data; // Update the scoped variable
          }}
        />
      ),
      confirmText: 'Save Changes',
      onConfirm: async () => {
        // Read data from the scoped variable
        const { name: newName, isEmergency: newIsEmergency } = modalData;
        const finalName = newName.trim() || currentName; // Use current name if trimmed is empty
        let nameChanged = false;
        let emergencyChanged = false;

        try {
          // Update name if changed
          if (finalName !== currentName) {
            await renamePage(activeProfileId, bankIndex, finalName);
            setBankNames(prev => ({ ...prev, [bankIndex]: finalName }));
            nameChanged = true;
            console.log(`Renamed bank ${bankNumber} to "${finalName}"`);
          }

          // Update emergency state if changed
          if (newIsEmergency !== currentIsEmergency) {
            await setPageEmergencyState(activeProfileId, bankIndex, newIsEmergency);
            setEmergencyBanks(prev => ({ ...prev, [bankIndex]: newIsEmergency }));
            emergencyChanged = true;
            console.log(`Set emergency status for bank ${bankNumber} to ${newIsEmergency}`);
          }

          if (nameChanged || emergencyChanged) {
            // Optionally show success feedback
          }

        } catch (error) {
          console.error(`Failed to update bank ${bankNumber}:`, error);
          // TODO: Show error feedback in modal or via toast
          alert(`Failed to update bank ${bankNumber}. Please try again.`);
        } finally {
          closeModal(); // Close the modal after operation
          // Set editing state back to false. The listener will handle isEditMode.
          setEditing(false);
        }
      },
      onCancel: () => {
        // Also handle setting editing state back on cancel
        setEditing(false);
        // closeModal is handled by the store automatically
      }
    });
  };
  
  return (
    <main className={`flex min-h-screen flex-col items-center p-8 pb-0 bg-gray-100 dark:bg-gray-800 ${isEditMode ? 'edit-mode' : ''}`}>
      {/* Edit mode indicator */}
      {isEditMode && (
        <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center py-1 z-50">
          <span className="font-bold">EDIT MODE</span> <span className="text-sm">(Release SHIFT to exit)</span>
        </div>
      )}
      {/* Fixed position header to prevent layout shifts */}
      <div className="w-full mb-8 flex flex-col gap-2">
        <div className="flex justify-between items-center">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100">
            ImpAmp3 Soundboard
          </h1>
          
          {/* Profile Selector and Search Icon */}
          <div className="flex items-center space-x-4">
            {/* Search Icon */}
            <SearchButton />
            
            {/* Using the memoized ProfileSelector render function */}
            {renderProfileSelector()}
          </div>
        </div>
      </div>
      
      {/* Content container */}
      <div className="w-full flex-1 flex flex-col mb-24">
        {/* Main content area */}
        <div className="flex flex-col min-w-0">
          {/* Help text panel */}
          <div className="bg-white dark:bg-gray-700 rounded-lg p-4 mb-4 shadow-sm">
            <div className="text-gray-700 dark:text-gray-300">
              <span className="font-medium text-lg">ImpAmp Soundboard</span>
              <span className="text-sm ml-4 text-gray-500">
                {isEditMode 
                  ? "Shift+click to rename banks and pads." 
                  : "Press 1-9, 0 to switch banks 1-9, 10. Press Ctrl+1 through Ctrl+0 for banks 11-20. Hold SHIFT for edit mode. "
                }
              </span>
            </div>
          </div>
          
          {/* Bank/Page Tabs - moved below help text */}
          <div className="mb-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center">
              {/* Bank Selector Tabs - show all available banks */}
              <div className="flex flex-1 space-x-1 overflow-x-auto pb-1" role="tablist">
                {Object.keys(bankNames).map((bankKey) => {
                  const index = parseInt(bankKey, 10);
                  const bankNumber = convertIndexToBankNumber(index);
                  return (
                  <button
                    key={index}
                    data-bank-index={index}
                    role="tab"
                    aria-selected={index === currentPageIndex}
                    onClick={() => { 
                      // Rely solely on isEditMode from the store
                      if (isEditMode) { 
                        handleBankClick(index, true);
                      } else {
                        useProfileStore.getState().setCurrentPageIndex(bankNumber);
                      }
                    }}
                    className={`relative px-4 py-2 rounded-t-lg flex items-center text-sm font-medium transition-colors
                      ${index === currentPageIndex
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                      } 
                      ${isEditMode ? 'border-t-2 border-x-2 border-dashed border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20' : ''}
                      ${emergencyBanks[index] ? 'ring-1 ring-red-500' : ''}`}
                    aria-label={`${isEditMode ? 'Edit' : 'Switch to'} bank ${bankNumber}`}
                    title={isEditMode 
                      ? `${bankNames[index] || `Bank ${bankNumber}`}${emergencyBanks[index] ? ' (Emergency)' : ''}\nShift+click to rename`
                      : bankNames[index] || `Bank ${bankNumber}`}
                  >
                    <span>{bankNumber}: {bankNames[index] || `Bank ${bankNumber}`}</span>
                    {emergencyBanks[index] && (
                      <span className="ml-2 w-3 h-3 bg-red-500 rounded-full" 
                            title="Emergency bank"></span>
                    )}
                  </button>
                  );
                })}
              </div>
              
              {/* Add Bank Button (only shown in edit mode) */}
              {isEditMode && (
                <button
                  onClick={() => {
                    console.log('[Add Bank Button] Clicked!'); // DEBUG LOG
                    // Find the next available bank number
                    // Get all current bank indices and find the next available index
                    const usedIndices = Object.keys(bankNames).map(k => parseInt(k, 10));
                    let nextIndex = 10; // Start at index 10 (bank 11) for new banks
                    
                    // Find the first unused index starting from 10
                    while (usedIndices.includes(nextIndex)) {
                      nextIndex++;
                    }
                    if (nextIndex >= 20) {
                      alert('Maximum number of banks reached (20)');
                      return;
                    }
                    
                    // Get the bank number for display
                    const nextBankNumber = convertIndexToBankNumber(nextIndex);

                    console.log(`[Add Bank Button] isEditMode=${isEditMode}, activeProfileId=${activeProfileId}, nextIndex=${nextIndex}, nextBankNumber=${nextBankNumber}`); // DEBUG LOG

                    // Variable to hold the new bank name
                    let modalDataValue = `Bank ${nextBankNumber}`;

                    // Set editing state to true before opening modal
                    setEditing(true);

                    openModal({
                      title: 'Add New Bank',
                      content: (
                        <PromptModalContent
                          label={`Enter name for new bank ${nextBankNumber}:`}
                          initialValue={`Bank ${nextBankNumber}`}
                          onValueChange={(value) => {
                            modalDataValue = value; // Update scoped variable
                          }}
                        />
                      ),
                      confirmText: 'Create Bank',
                      onConfirm: async () => {
                        // Read data from scoped variable
                        const newBankName = modalDataValue;
                        const finalBankName = newBankName.trim() || `Bank ${nextBankNumber}`;

                        if (activeProfileId !== null) {
                          try {
                            await upsertPageMetadata({
                              profileId: activeProfileId,
                              pageIndex: nextIndex,
                              name: finalBankName,
                              isEmergency: false
                            });

                            // Update local state
                            setBankNames(prev => ({
                              ...prev,
                              [nextIndex]: finalBankName
                            }));
                            setEmergencyBanks(prev => ({ // Also ensure emergency state is set
                              ...prev,
                              [nextIndex]: false
                            }));


                            // Switch to the new bank
                            useProfileStore.getState().setCurrentPageIndex(nextBankNumber);

                            console.log(`Created new bank ${nextBankNumber} (index ${nextIndex}): ${finalBankName}`);
                          } catch (error) {
                            console.error(`Failed to create new bank:`, error);
                            alert('Failed to create new bank. Please try again.');
                          } finally {
                            closeModal();
                            // Set editing state back. The listener will handle isEditMode.
                            setEditing(false);
                          }
                        } else {
                          console.error('[Add Bank Button] activeProfileId is null, cannot create bank.');
                          alert('Cannot create bank, no active profile.');
                          closeModal();
                          // Set editing state back. The listener will handle isEditMode.
                          setEditing(false);
                        }
                      },
                      onCancel: () => {
                        // Set editing state back on cancel
                        setEditing(false);
                        // closeModal is handled by the store automatically
                      }
                    });
                  }}
                  className="ml-2 px-3 py-2 rounded flex items-center justify-center text-sm font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                  aria-label="Add new bank"
                  title="Add new bank"
                >
                  <span className="text-lg font-bold">+</span>
                </button>
              )}
            </div>
          </div>
          
          {/* Pass the current page index to PadGrid */}
          <PadGrid currentPageIndex={currentPageIndex} />
        </div>
      </div>
      
      {/* Active Tracks panel at the bottom of the screen */}
      <div className="fixed bottom-0 left-0 right-0 z-50">
        <ActiveTracksPanel />
      </div>
    </main>
  );
}
