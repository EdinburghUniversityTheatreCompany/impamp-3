import { test, expect } from '@playwright/test';
import { prepareAudioContext } from './test-helpers';

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
    await firstPad.click();

    // Wait for the modal to appear
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText('Rename Pad');

    // Fill the input and confirm
    const inputField = page.locator('[data-testid="prompt-input"]');
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
});
