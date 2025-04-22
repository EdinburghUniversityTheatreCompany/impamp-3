import { test, expect } from '@playwright/test';
import { createTestAudioFilePath, activatePad, prepareAudioContext } from './test-helpers';

test.describe('ImpAmp3 Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto('/');
    
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    
    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });
  
  test('Keyboard shortcuts activate pads', async ({ page }) => {
    // Create a test audio file path
    const expectedFileName = 'key-test-audio';
    const audioFilePath = await createTestAudioFilePath(expectedFileName);
    
    // Get the first pad (mapped to 'q' key) and its input
    const firstPad = page.locator('[id^="pad-"]').first();
    const firstPadInput = page.locator('[data-testid="pad-drop-input-0"]');
    
    // Add audio to the pad
    await firstPadInput.setInputFiles(audioFilePath);
    
    // Verify pad shows the name
    await expect(firstPad).toContainText(expectedFileName, { timeout: 5000 });
    
    // Activate the pad and verify it's playing
    await activatePad(page, firstPad, 'q');
    
    // Wait for the pad to show it's playing
    const progressBar = firstPad.locator('.bg-green-500');
    await expect(progressBar).toBeVisible({timeout: 5000});
    
    // Verify the active tracks panel shows the sound
    await expect(page.locator('text=Nothing playing')).toBeHidden({timeout: 5000});
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activeTracksPanel.getByText(expectedFileName)).toBeVisible();
  });

  test('ESC key stops all playing sounds', async ({ page }) => {
    // Create a test audio file path
    const expectedFileName = 'esc-test-audio';
    const audioFilePath = await createTestAudioFilePath(expectedFileName);
    
    // Get the first pad and its input
    const firstPad = page.locator('[id^="pad-"]').first();
    const firstPadInput = page.locator('[data-testid="pad-drop-input-0"]');
    
    // Add audio to the pad
    await firstPadInput.setInputFiles(audioFilePath);
    
    // Verify pad shows the name
    await expect(firstPad).toContainText(expectedFileName, { timeout: 5000 });
    
    // Activate the pad and verify it's playing
    await activatePad(page, firstPad);
    
    // Press Escape key
    await page.keyboard.press('Escape');
    
    // Verify the sound stopped (check panel and pad progress bar)
    await expect(page.locator('text=Nothing playing')).toBeVisible({timeout: 5000});
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activeTracksPanel.getByText(expectedFileName)).toBeHidden();
    await expect(firstPad.locator('.bg-green-500')).not.toBeVisible();
  });

  test('Number keys switch between banks', async ({ page }) => {
    // Wait for banks to load - look for tab list
    await page.waitForSelector('[role="tablist"]');
    
    // Find the selected bank tab
    const selectedBankTab = page.locator('[aria-selected="true"]');
    await expect(selectedBankTab).toBeVisible();
    await expect(selectedBankTab).toContainText('Bank 1');
    
    // Press key '2' to switch to Bank 2
    await page.keyboard.press('2');
    
    // Verify we switched to Bank 2
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toContainText('Bank 2');
    
    // Press key '0' to switch to Bank 10
    await page.keyboard.press('0');
    
    // Verify we switched to Bank 10
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toContainText('Bank 10');
    
  });

  test('Control key switches between banks', async ({ page }) => {
    // This first part is also tested in the edit-mode.spec.ts file

   // Enter edit mode
   await page.keyboard.down('Shift');
   await page.waitForTimeout(300);
   
   // Find the "+" button to add a new bank
   const addBankButton = page.getByRole('button', { name: 'Add new bank' })
   await expect(addBankButton).toBeVisible();
   
   // Get the initial number of banks
   const initialBanks = await page.locator('[role="tab"]').count();

   // Click add bank button
   await addBankButton.click();

   // Wait for the 'Add New Bank' modal
   await page.waitForSelector('[data-testid="custom-modal"]');
   await expect(page.locator('[data-testid="modal-title"]')).toContainText('Add New Bank');

   // Click confirm to accept default name
   await page.locator('[data-testid="modal-confirm-button"]').click();

   // Wait for modal to disappear
   await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

   // Verify a new bank tab appears
   await expect(page.locator('[role="tab"]')).toHaveCount(initialBanks + 1);

   // Release Shift key to exit edit mode before testing keyboard shortcuts
   await page.keyboard.up('Shift');
   await page.waitForTimeout(300); // Wait for edit mode to deactivate

   // NOTE: This bit is unique for this test

    // Press Alt+1 to switch to Bank 11
    await page.keyboard.press('Control+1');
    
    // Verify we switched to Bank 11
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toContainText('Bank 11');
  });
});
