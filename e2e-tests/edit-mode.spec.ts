import { test, expect, Page } from '@playwright/test'; // Added Page type
import {
  prepareAudioContext,
  createTestAudioFilePath,
  createMultipleTestAudioFiles,
  // Import the moved helpers
  openEditPadModal,
  addSoundsToPadModal,
  setPlaybackModeInModal,
  removeSoundFromModal,
  savePadEditModal,
} from './test-helpers';
import { PlaybackType } from '../src/lib/db'; // Added PlaybackType

// Helper definitions moved to test-helpers.ts

test.describe('ImpAmp3 Edit Mode', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto('/');
    
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    
    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test('Shift key activates and deactivates edit mode', async ({ page }) => {
    // Wait for the app to be fully loaded
    await page.waitForSelector('[id^="pad-"]');
    
    // Check initial state - we'll use page content snapshot to verify no EDIT MODE text
    const initialContent = await page.textContent('body');
    expect(initialContent).not.toContain('EDIT MODE');
    
    // Press and hold the Shift key
    await page.keyboard.down('Shift');
    
    // Wait for a short time to ensure edit mode activates
    await page.waitForTimeout(300);
    
    // Verify edit mode is activated - EDIT MODE text should now be visible
    const editModeElement = page.getByText('EDIT MODE', { exact: true });
    await expect(editModeElement).toBeVisible();
    
    // Release the Shift key
    await page.keyboard.up('Shift');
    
    // Wait for edit mode to deactivate
    await page.waitForTimeout(300);
    
    // Verify edit mode is deactivated - check page content again
    const finalContent = await page.textContent('body');
    expect(finalContent).not.toContain('EDIT MODE');
  });
  
  test('Can rename pads in edit mode', async ({ page }) => {
    // Enter edit mode
    await page.keyboard.down('Shift');
    await page.waitForTimeout(300);
    
    // Verify edit mode is active
    await expect(page.getByText('EDIT MODE', { exact: true })).toBeVisible();
    
    // Get the first pad
    const firstPad = page.locator('[id^="pad-"]').first();
    
    // Store the original pad text (ensure it's not null)
    const originalText = await firstPad.textContent() ?? '';

    // Click the pad to trigger rename (Shift is already down)
    // Click the pad to trigger the EDIT modal (Shift is already down)
    await firstPad.click();

    // Wait for the EDIT modal to appear
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText('Edit Pad'); // Expect Edit Pad modal now

    // Fill the name input in the EDIT modal and confirm
    const inputField = page.locator('[data-testid="edit-pad-name-input"]'); // Use the correct test ID
    await inputField.fill('Custom Pad Name');
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key (or ensure it's released if test requires it)
    // Note: The modal logic itself handles releasing edit mode if shift is up *after* confirm/cancel
    // We might not need to explicitly release shift here if the modal handles it. Let's keep it for now.
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300); // Wait for potential state updates
    
    // Verify the pad name was updated
    await expect(firstPad).toContainText('Custom Pad Name');
    expect(await firstPad.textContent()).not.toBe(originalText);
  });
  
  test('Can create new banks and rename them', async ({ page }) => {
    // Enter edit mode
    await page.keyboard.down('Shift');
    await page.waitForTimeout(300);
    
    // Find the "+" button to add a new bank
    const addBankButton = page.getByRole('button', { name: 'Add new bank' })
    await expect(addBankButton).toBeVisible();
    
    // Get the initial number of banks
    const initialBanks = await page.locator('[role="tab"]').count();

    // --- Create the new bank ---
    await addBankButton.click();

    // Wait for the 'Add New Bank' modal
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText('Add New Bank');

    // Verify default name in input (optional but good)
    const addInput = page.locator('[data-testid="prompt-input"]');
    await expect(addInput).toHaveValue(`Bank ${initialBanks + 1}`); // Assumes banks are 1-indexed

    // Click confirm to accept default name
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Verify a new bank tab appears
    await expect(page.locator('[role="tab"]')).toHaveCount(initialBanks + 1);
    const newBankTab = page.locator('[role="tab"]').last(); // Get the newly added tab
    await expect(newBankTab).toContainText(`Bank ${initialBanks + 1}`);

    // --- Rename the new bank ---
    // Ensure Shift is still down (or press it again if needed)
    await page.keyboard.down('Shift');
    await page.waitForTimeout(300); // Ensure edit mode is active

    // Click the new bank tab to trigger edit modal
    await newBankTab.click();

    // Wait for the 'Edit Bank' modal
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText(`Edit Bank ${initialBanks + 1}`);

    // Fill the name input
    const nameInput = page.locator('[data-testid="bank-name-input"]');
    await nameInput.fill('Custom Bank');

    // Ensure emergency checkbox is not checked (it shouldn't be by default)
    const emergencyCheckbox = page.locator('[data-testid="emergency-checkbox"]');
    await expect(emergencyCheckbox).not.toBeChecked();

    // Click confirm
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);

    // Verify the bank name was updated on the tab
    await expect(newBankTab).toContainText(`Custom Bank`);
    // Also check the title attribute for the full name
    await expect(newBankTab).toHaveAttribute('title', 'Custom Bank');
  });
  
  test('Can mark a bank as emergency', async ({ page }) => {
    // Enter edit mode
    await page.keyboard.down('Shift');
    await page.waitForTimeout(300);

    // Find the first bank tab
    const firstBankTab = page.locator('[role="tab"]').first();
    // const initialBankName = await firstBankTab.textContent() ?? ''; // Removed unused variable

    // Verify emergency indicator is initially hidden
    const emergencyIndicatorSelector = 'span.ml-2.w-3.h-3.bg-red-500.rounded-full';
    await expect(firstBankTab.locator(emergencyIndicatorSelector)).toBeHidden();

    // Click the first bank tab to open the edit modal
    await firstBankTab.click();

    // Wait for the 'Edit Bank' modal
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText('Edit Bank 1'); // Assuming first bank is Bank 1

    // Check the emergency checkbox
    const emergencyCheckbox = page.locator('[data-testid="emergency-checkbox"]');
    await emergencyCheckbox.check();

    // Click confirm
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);

    // Verify the emergency indicator is now visible on the first bank tab
    // Re-locate the tab
    const updatedFirstBankTab = page.locator('[role="tab"]').first();
    await expect(updatedFirstBankTab.locator(emergencyIndicatorSelector)).toBeVisible();
    // Verify title attribute also indicates emergency
    await expect(updatedFirstBankTab).toHaveAttribute('title', expect.stringContaining('(Emergency)'));
  });

  // --- Tests for Multi-Sound Pad Editing ---

  test('opens edit modal on Shift+click (empty pad)', async ({ page }) => {
    await openEditPadModal(page, 0); // Open modal for first pad
    // Verify some elements inside the modal to confirm it's the right one
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="edit-pad-sounds-list"]')).not.toBeVisible(); // List shouldn't exist if empty
    await expect(page.getByText('No sounds assigned.')).toBeVisible();
    await expect(page.locator('[data-testid="edit-pad-add-sounds-button"]')).toBeVisible();
  });

  test('opens edit modal on Shift+click (single sound pad)', async ({ page }) => {
    const fileName = 'single-sound-edit';
    const filePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-1"]'); // Use second pad
    await padInput.setInputFiles(filePath);
    await expect(page.locator('[id^="pad-"][id$="-1"]')).toContainText(fileName, { timeout: 5000 });

    await openEditPadModal(page, 1); // Open modal for second pad

    // Verify elements, including the single sound in the list
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toHaveValue(fileName);
    await expect(page.locator('[data-testid="edit-pad-sounds-list"]')).toBeVisible();
    await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileName}")`)).toBeVisible();
    await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(1); // Ensure only one item
  });

   test('adds multiple sounds via modal', async ({ page }) => {
    const fileNames = ['soundA', 'soundB'];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    await openEditPadModal(page, 2); // Use third pad
    await addSoundsToPadModal(page, filePaths);

    // Verify sounds appear in the modal list
    await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[0]}")`)).toBeVisible();
    await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`)).toBeVisible();
    await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(2);

    await savePadEditModal(page);

    // Verify pad is configured (check name updated to first sound)
    const pad = page.locator('[id^="pad-"][id$="-2"]');
    await expect(pad).toContainText(fileNames[0]); // Name should update
  });

  test('updates pad name correctly when adding first sounds', async ({ page }) => {
    const fileNames = ['firstSoundName'];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    await openEditPadModal(page, 3); // Use fourth pad
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toHaveValue('Empty Pad'); // Verify initial state

    await addSoundsToPadModal(page, filePaths);
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toHaveValue(fileNames[0]); // Verify name updated in modal

    await savePadEditModal(page);

    // Verify pad name is updated on the grid
    const pad = page.locator('[id^="pad-"][id$="-3"]');
    await expect(pad).toContainText(fileNames[0]);
  });

  test('preserves existing pad name when adding more sounds', async ({ page }) => {
    const initialName = 'initial-sound';
    const customName = 'My Custom Pad';
    const additionalSound = 'additional-sound';
    const initialFilePath = await createTestAudioFilePath(initialName);
    const additionalFilePath = await createTestAudioFilePath(additionalSound);

    // Configure pad 4 with one sound
    const padInput = page.locator('[data-testid="pad-drop-input-4"]');
    await padInput.setInputFiles(initialFilePath);
    await expect(page.locator('[id^="pad-"][id$="-4"]')).toContainText(initialName, { timeout: 5000 });

    // Rename it
    await page.keyboard.down('Shift');
    await page.locator('[id^="pad-"][id$="-4"]').click();
    await page.waitForSelector('[data-testid="custom-modal"]'); // Wait for rename modal
    await page.locator('[data-testid="prompt-input"]').fill(customName);
    await page.locator('[data-testid="modal-confirm-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
    await expect(page.locator('[id^="pad-"][id$="-4"]')).toContainText(customName);
    await page.keyboard.up('Shift'); // Release shift after rename

    // Open edit modal again
    await openEditPadModal(page, 4);
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toHaveValue(customName); // Verify custom name loaded

    // Add another sound
    await addSoundsToPadModal(page, [additionalFilePath]);
    await expect(page.locator('[data-testid="edit-pad-name-input"]')).toHaveValue(customName); // Verify name NOT changed

    await savePadEditModal(page);

    // Verify pad name is still the custom name
    const pad = page.locator('[id^="pad-"][id$="-4"]');
    await expect(pad).toContainText(customName);
  });

  test('removes a sound via modal', async ({ page }) => {
    const fileNames = ['soundToRemove', 'soundToKeep'];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add two sounds via modal
    await openEditPadModal(page, 5); // Use pad 5
    await addSoundsToPadModal(page, filePaths);
    await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(2);

    // Remove the first sound
    await removeSoundFromModal(page, fileNames[0]);
    await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`)).toBeVisible();

    await savePadEditModal(page);

    // Re-open modal to verify persistence (or use playback test)
    await openEditPadModal(page, 5);
    await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`)).toBeVisible();
  });

  test('changes playback mode via modal', async ({ page }) => {
    const fileNames = ['modeTestA', 'modeTestB'];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add sounds
    await openEditPadModal(page, 6); // Use pad 6
    await addSoundsToPadModal(page, filePaths);

    // Check default mode (should be round-robin now)
    await expect(page.locator('[data-testid="edit-pad-playback-mode-round-robin"]')).toBeChecked();

    // Change to sequential
    await setPlaybackModeInModal(page, 'sequential');
    await expect(page.locator('[data-testid="edit-pad-playback-mode-sequential"]')).toBeChecked();

    await savePadEditModal(page);

    // Re-open and verify mode persisted
    await openEditPadModal(page, 6);
    await expect(page.locator('[data-testid="edit-pad-playback-mode-sequential"]')).toBeChecked();
  });

  test('X button / Delete+click opens modal for multi-sound pad', async ({ page }) => {
    const fileNames = ['multiSoundX1', 'multiSoundX2'];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add two sounds via modal to pad 7
    await openEditPadModal(page, 7);
    await addSoundsToPadModal(page, filePaths);
    await savePadEditModal(page);

    // Enter edit mode
    await page.keyboard.down('Shift');
    await page.waitForTimeout(200);

    // Click the 'X' button on the pad itself
    const pad = page.locator('[id^="pad-"][id$="-7"]');
    const xButton = pad.locator('button[aria-label="Remove sound"]');
    await expect(xButton).toBeVisible();
    await xButton.click();

    // Verify the EDIT modal opened, not the confirmation modal
    await expect(page.locator('[data-testid="custom-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="modal-title"]')).toContainText('Edit Pad'); // Not "Remove Sound"
    await expect(page.locator('[data-testid="edit-pad-sounds-list"]')).toBeVisible(); // Check for edit content

    // Close modal and release shift
    await page.locator('[data-testid="modal-cancel-button"]').click(); // Assuming cancel exists
    await page.keyboard.up('Shift');
  });

});
