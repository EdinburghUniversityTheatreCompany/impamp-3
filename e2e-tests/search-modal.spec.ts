import { test, expect } from '@playwright/test';
import { createTestAudioFilePath, prepareAudioContext } from './test-helpers';

test.describe('Search Modal', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto('/');
    
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    
    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test('should open, allow searching, play sound, and close automatically on sound selection', async ({ page }) => {
    // --- Setup: Add a known sound to a pad ---
    const expectedFileName = 'Accordion_BassNote_01';
    const audioFilePath = await createTestAudioFilePath(expectedFileName);

    // Get the first pad and its corresponding file input
    const firstPad = page.locator('[id^="pad-"]').first();
    // Assuming the input is associated with the first pad (index 0)
    const firstPadInput = page.locator('[data-testid="pad-drop-input-0"]'); 

    // Add audio to the pad using setInputFiles
    await firstPadInput.setInputFiles(audioFilePath);
    
    // Verify the pad shows the file name (adjust timeout if needed)
    await expect(firstPad).toContainText(expectedFileName, { timeout: 10000 }); // Increased timeout

    // --- Open Search Modal ---
    const searchButtonSelector = '[data-testid="search-button"]'; 
    await page.locator(searchButtonSelector).click();

    // --- Verify Modal is Open ---
    const modalSelector = '[data-testid="search-modal"]'; 
    const searchModal = page.locator(modalSelector);
    await expect(searchModal).toBeVisible();

    // --- Search for the Uploaded Sound ---
    const searchInputSelector = `${modalSelector} input[placeholder="Search sounds..."]`; // Scope input to modal
    await page.locator(searchInputSelector).fill(expectedFileName); 

    // --- Wait for and Click Result ---
    // Wait for results to appear. Select the result matching the uploaded file.
    const searchResultSelector = `${modalSelector} [data-testid="search-result-item"]:has-text("${expectedFileName}")`; 
    const firstResult = page.locator(searchResultSelector).first();
    
    // Wait for the result to be visible before clicking
    await expect(firstResult).toBeVisible({ timeout: 10000 }); 
    await firstResult.click();

    // --- Verify Modal is Closed ---
    // After clicking the result, the modal should close automatically
    await expect(searchModal).toBeHidden(); 
    
    // Verify the active tracks panel shows the correct track playing
    await expect(page.locator('[data-testid="active-tracks-panel"]').getByText(expectedFileName)).toBeVisible({ timeout: 10000 }); // Increased timeout
  });
});
