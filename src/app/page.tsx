"use client";

import React, { useEffect, useCallback } from "react"; // Removed useRef, useState
import dynamic from "next/dynamic";
import PadGrid from "@/components/PadGrid";
import BankTabStrip from "@/components/BankTabStrip";
import ActiveTracksPanel from "@/components/ActiveTracksPanel";
import ArmedTracksPanel from "@/components/ArmedTracksPanel";
import PlaybackAnnouncer from "@/components/PlaybackAnnouncer";
import {
  HelpButton,
  DeleteMoveModeButton,
  LoudnessOverviewButton,
  SearchButton,
  EditModeButton,
} from "@/components/buttons";
import { useProfileStore } from "@/store/profileStore";
import { getSyncState } from "@/lib/syncState";
import { useUIStore } from "@/store/uiStore";
import { useFormModal } from "@/hooks/modal/useFormModal";
import EditBankForm from "@/components/modals/EditBankForm";
import type { BankFormValues, FormErrors } from "@/types/forms";
import PromptModalContent from "@/components/modals/PromptModalContent";
import {
  renameBank,
  setBankEmergencyState,
  createBank,
  reorderBanks,
} from "@/lib/db";
import { MAX_BANKS } from "@/lib/constants";
import { convertIndexToBankNumber } from "@/lib/bankUtils";
import { positionOfBank } from "@/lib/bankOrder";
import BackupReminderNotification from "@/components/BackupReminderNotification"; // Import the new component

// Pre-load ProfileSelector component to avoid remounting during bank switches
const ProfileSelector = dynamic(
  () => import("@/components/profiles/ProfileSelector"),
  {
    ssr: false,
    loading: () => (
      <div className="w-24 h-10 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse"></div>
    ),
  },
);

export default function Home() {
  // Get state and utility functions from profile store
  const activeProfileId = useProfileStore((state) => state.activeProfileId);
  const isEditMode = useProfileStore((state) => state.isEditMode);
  const isDeleteMoveMode = useProfileStore((state) => state.isDeleteMoveMode);
  const readOnlyReason = useProfileStore((state) => {
    const active = state.profiles.find((p) => p.id === state.activeProfileId);
    if (!active) return null;
    const sync = getSyncState(active);
    if (sync.canEdit) return null;
    return sync.following
      ? "You are following this profile — stop following it to make changes."
      : "You have view-only access to this profile.";
  });
  const incrementPadConfigsVersion = useProfileStore(
    (state) => state.incrementPadConfigsVersion,
  ); // Get the action
  const requestSync = useProfileStore((state) => state.requestSync);
  // Bumped by sync after it applies a remote change; see the bank-metadata
  // effect below.
  const padConfigsVersion = useProfileStore((state) => state.padConfigsVersion);
  // Get modal actions (selected individually to avoid re-rendering on modal state changes)
  const openModal = useUIStore((state) => state.openModal);
  const closeModal = useUIStore((state) => state.closeModal);

  // Memoized components to prevent unnecessary remounting
  const renderProfileSelector = useCallback(() => {
    return <ProfileSelector />;
  }, []); // Empty dependency array ensures this doesn't change when banks switch

  // Bank metadata, keyed by identity rather than position.
  const banks = useProfileStore((state) => state.banks);
  const currentBankId = useProfileStore((state) => state.currentBankId);
  const loadBanks = useProfileStore((state) => state.loadBanks);

  // `padConfigsVersion` is deliberately present: it is the counter sync
  // bumps after it applies a remote change, and without it a bank renamed by
  // a collaborator never appeared until the profile was switched.
  useEffect(() => {
    if (activeProfileId === null) return;
    void loadBanks(activeProfileId);
  }, [activeProfileId, padConfigsVersion, loadBanks]);

  // Get form modal hook
  const { openFormModal } = useFormModal();

  // Handle a bank tab click while in edit mode: open the rename/emergency dialog.
  const handleBankEdit = (bankId: string) => {
    if (activeProfileId === null) return;
    const bank = banks.find((b) => b.bankId === bankId);
    if (!bank) return;

    const position = positionOfBank(banks, bankId);
    const bankNumber = convertIndexToBankNumber(position);
    const currentName = bank.name;
    const currentIsEmergency = bank.isEmergency;

    // Open form modal with current values
    openFormModal<BankFormValues>({
      title: `Edit Bank ${bankNumber}`,
      initialValues: {
        name: currentName,
        isEmergency: currentIsEmergency,
      },
      renderForm: (props) => <EditBankForm {...props} />,
      validate: (values) => {
        const errors: FormErrors<BankFormValues> = {};
        if (!values.name.trim()) {
          errors.name = "Bank name is required";
        }
        return errors;
      },
      onSubmit: async (values) => {
        const { name: newName, isEmergency: newIsEmergency } = values;
        const finalName = newName.trim() || currentName; // Use current name if trimmed is empty

        try {
          // Update name if changed
          if (finalName !== currentName) {
            await renameBank(activeProfileId, bankId, finalName);
            console.log(`Renamed bank ${bankNumber} to "${finalName}"`);
          }

          // Update emergency state if changed
          if (newIsEmergency !== currentIsEmergency) {
            await setBankEmergencyState(
              activeProfileId,
              bankId,
              newIsEmergency,
            );
            // Invalidate every cached copy of pad data, the keyboard's
            // emergency set included, only if the state actually changed
            incrementPadConfigsVersion();
            console.log(
              `Set emergency status for bank ${bankNumber} to ${newIsEmergency}, triggered emergency sounds refresh`,
            );
          }
          if (
            finalName !== currentName ||
            newIsEmergency !== currentIsEmergency
          ) {
            await loadBanks(activeProfileId);
          }
          requestSync(activeProfileId);
        } catch (error) {
          console.error(`Failed to update bank ${bankNumber}:`, error);
          alert(`Failed to update bank ${bankNumber}. Please try again.`);
          throw error; // Re-throw to prevent modal from closing
        }
      },
      confirmText: "Save Changes",
      size: "sm",
    });
  };

  // Handle a bank tab click outside edit mode: switch to that bank.
  const handleBankSelect = (bankId: string) => {
    const position = positionOfBank(banks, bankId);
    if (position < 0) return;
    useProfileStore
      .getState()
      .setCurrentPageIndex(convertIndexToBankNumber(position));
  };

  return (
    <main
      className={`flex min-h-dvh flex-col items-center p-4 pb-0 sm:p-8 sm:pb-0 bg-gray-100 dark:bg-gray-800 ${isEditMode ? "edit-mode" : ""}`}
    >
      {/* Mode indicators */}
      {isEditMode && (
        <div className="fixed top-0 left-0 right-0 bg-amber-500 text-white text-center pb-1 pt-safe z-50">
          <span className="font-bold">EDIT MODE</span>{" "}
          <span className="text-sm">(Release SHIFT to exit)</span>
        </div>
      )}
      {isDeleteMoveMode && (
        <div className="fixed top-0 left-0 right-0 bg-red-500 text-white text-center pb-1 pt-safe z-50">
          <span className="font-bold">DELETE AND MOVE MODE</span>{" "}
          <span className="text-sm">(Click the button again to exit)</span>
        </div>
      )}
      {/*
        Say why the pads will not respond to Shift, rather than letting the
        key silently do nothing. Editing is refused for a profile that cannot
        push, because the next sync would overwrite the changes anyway.
      */}
      {readOnlyReason && (
        <div
          data-testid="read-only-banner"
          className="fixed top-0 right-0 left-0 z-50 bg-slate-600 pb-1 pt-safe text-center text-white"
        >
          <span className="font-bold">VIEW ONLY</span>{" "}
          <span className="text-sm">{readOnlyReason}</span>
        </div>
      )}
      {/* Fixed position header to prevent layout shifts */}
      <div className="w-full mb-8 flex flex-col gap-2">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <h1 className="text-2xl sm:text-4xl font-bold text-gray-900 dark:text-gray-100">
            ImpAmp3 Soundboard
          </h1>

          {/* Profile Selector and Action Buttons */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            {/* Search Button */}
            <SearchButton />

            {/* Help Button */}
            <HelpButton />

            {/* Loudness Overview Button */}
            <LoudnessOverviewButton />

            {/* Edit Mode Button */}
            <EditModeButton />

            {/* Delete/Move Mode Button */}
            <DeleteMoveModeButton />

            {/* Using the memoized ProfileSelector render function */}
            {renderProfileSelector()}
          </div>
        </div>
      </div>

      {/* Backup Reminder Notification */}
      <BackupReminderNotification />

      {/* Content container */}
      <div className="w-full flex-1 flex flex-col">
        {/* Main content area */}
        <div className="flex flex-col min-w-0">
          {/* Help text panel */}
          <div className="bg-white dark:bg-gray-700 rounded-lg p-4 mb-4 shadow-sm">
            <div className="text-gray-700 dark:text-gray-300">
              <span className="font-medium text-lg">ImpAmp Soundboard</span>
              <span className="text-sm ml-4 text-gray-500">
                {isEditMode
                  ? "Shift+click to rename banks and pads."
                  : isDeleteMoveMode
                    ? "Click pads to delete them. Drag pads to swap their positions."
                    : "Press 1-9, 0 to switch banks 1-9, 10. Press Ctrl+1 through Ctrl+0 for banks 11-20. Hold SHIFT for edit mode. Press Shift+? for help."}
              </span>
            </div>
          </div>

          {/* Bank/Page Tabs - moved below help text */}
          <div className="mb-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center">
              {/* Bank Selector Tabs - show all available banks */}
              <BankTabStrip
                banks={banks}
                currentBankId={currentBankId}
                isEditMode={isEditMode}
                onSelect={handleBankSelect}
                onEdit={handleBankEdit}
                onReorder={async (orderedBankIds) => {
                  if (activeProfileId === null) return;
                  try {
                    await reorderBanks(activeProfileId, orderedBankIds);
                    await loadBanks(activeProfileId);
                    incrementPadConfigsVersion();
                    requestSync(activeProfileId);
                  } catch (error) {
                    console.error("Failed to reorder the banks:", error);
                    alert("Failed to reorder the banks. Please try again.");
                  }
                }}
              />

              {/* Add Bank Button (only shown in edit mode) */}
              {isEditMode && (
                <button
                  disabled={banks.length >= MAX_BANKS}
                  onClick={() => {
                    if (banks.length >= MAX_BANKS) {
                      alert(`Maximum number of banks reached (${MAX_BANKS})`);
                      return;
                    }

                    // The bank about to be created lands at the next free
                    // position, which — since nothing ever deletes a bank —
                    // is simply one past the current count.
                    const nextBankNumber = banks.length + 1;

                    // Variable to hold the new bank name
                    let modalDataValue = `Bank ${nextBankNumber}`;

                    openModal({
                      title: "Add New Bank",
                      content: (
                        <PromptModalContent
                          label={`Enter name for new bank ${nextBankNumber}:`}
                          initialValue={`Bank ${nextBankNumber}`}
                          onValueChange={(value) => {
                            modalDataValue = value; // Update scoped variable
                          }}
                        />
                      ),
                      confirmText: "Create Bank",
                      onConfirm: async () => {
                        // Read data from scoped variable
                        const newBankName = modalDataValue;
                        const finalBankName =
                          newBankName.trim() || `Bank ${nextBankNumber}`;

                        if (activeProfileId !== null) {
                          try {
                            const newBank = await createBank(
                              activeProfileId,
                              finalBankName,
                            );
                            await loadBanks(activeProfileId);

                            // Switch to the new bank
                            const position = positionOfBank(
                              useProfileStore.getState().banks,
                              newBank.bankId,
                            );
                            if (position >= 0) {
                              useProfileStore
                                .getState()
                                .setCurrentPageIndex(
                                  convertIndexToBankNumber(position),
                                );
                            }

                            console.log(
                              `Created new bank "${finalBankName}" (id ${newBank.bankId})`,
                            );
                          } catch (error) {
                            console.error(`Failed to create new bank:`, error);
                            alert(
                              "Failed to create new bank. Please try again.",
                            );
                          } finally {
                            closeModal();
                          }
                        } else {
                          console.error(
                            "[Add Bank Button] activeProfileId is null, cannot create bank.",
                          );
                          alert("Cannot create bank, no active profile.");
                          closeModal();
                        }
                      },
                      onCancel: () => {
                        // closeModal is handled by the store automatically
                      },
                    });
                  }}
                  className="ml-2 px-3 py-2 rounded flex items-center justify-center text-sm font-medium bg-amber-500 text-white hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Add new bank"
                  title="Add new bank"
                >
                  <span className="text-lg font-bold">+</span>
                </button>
              )}
            </div>
          </div>

          {/* Pass the current bank's identity to PadGrid */}
          <PadGrid bankId={currentBankId ?? ""} />
        </div>
      </div>

      {/* What the panels below show, for anyone who cannot see them. Outside
          the panels on purpose — ArmedTracksPanel unmounts when its queue
          empties, and that is the transition most worth announcing. */}
      <PlaybackAnnouncer />

      {/* Tracks panels at the bottom of the screen */}
      {/* Sticky, not fixed. A fixed footer is outside flow, so the space it
          needs had to be guessed at with `mb-24` on the content — 96px for two
          always-mounted panels costing ~90px of chrome each plus up to 20dvh
          and 15dvh of scroll area. It covered the board whenever the guess was
          wrong. Sticky keeps the panels pinned to the bottom of the viewport
          while the page scrolls, which is what fixed bought, but the element
          still takes its own height in flow, so there is nothing to reserve
          and nothing to keep in step. */}
      <div className="sticky bottom-0 z-50 w-full">
        <ArmedTracksPanel />
        <ActiveTracksPanel />
      </div>
    </main>
  );
}
