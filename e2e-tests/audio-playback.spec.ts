import { test, expect } from '@playwright/test';
import { createTestAudioFilePath, prepareAudioContext } from './test-helpers'; // Updated imports

test.describe('ImpAmp3 Audio Playback', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the home page
    await page.goto('/');
    
    // Wait for the app to load properly
    await page.waitForSelector('[id^="pad-"]');
    
    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });
  
  test('UI elements are rendered correctly', async ({ page }) => {
    // Verify basic UI elements are present
    await expect(page.locator('.grid')).toBeVisible(); // Pad grid
    await expect(page.getByText('Nothing playing')).toBeVisible(); // Empty active tracks
    await expect(page.locator('[role="tablist"]')).toBeVisible(); // Bank tabs
  });
  
  test('Can play audio when clicking a pad with assigned sound', async ({ page }) => {
    // Define the expected file name
    const expectedFileName = 'Accordion_BassNote_01'; // Assuming app displays name without extension
    // Use the helper to create a temporary file with this name
    const audioFilePath = await createTestAudioFilePath(expectedFileName);
  
    // Get the first pad and its corresponding file input
    const firstPad = page.locator('[id^="pad-"]').first();
    const firstPadInput = page.locator('[data-testid="pad-drop-input-0"]'); // Use the data-testid
    
    // Add audio to the pad using setInputFiles
    await firstPadInput.setInputFiles(audioFilePath);
    
    // Verify the pad shows the file name (adjust timeout if needed)
    await expect(firstPad).toContainText(expectedFileName, { timeout: 5000 });
    
    // Click the pad to play the sound
    await firstPad.click();
    
    // Verify the pad shows as playing (look for the progress bar)
    await expect(firstPad.locator('.bg-green-500')).toBeVisible(); // Scope locator to the pad
    
    // Verify the active tracks panel shows the track (using data-testid)
    await expect(page.locator('[data-testid="active-tracks-panel"]').getByText(expectedFileName)).toBeVisible();
  });

  test('Clicking Active Track entry stops that specific track', async ({ page }) => {
    // Create a temporary test audio file path
    const firstAudioFileName = 'test-audio-1';
    const secondAudioFileName = 'test-audio-2';

    const firstAudioFilePath = await createTestAudioFilePath(firstAudioFileName);
    const secondAudioFilePath = await createTestAudioFilePath(secondAudioFileName);
    

    // Get the first two pads and their inputs
    const firstPad = page.locator('[id^="pad-"]').nth(0);
    const secondPad = page.locator('[id^="pad-"]').nth(1);
    const firstPadInput = page.locator('[data-testid="pad-drop-input-0"]');
    const secondPadInput = page.locator('[data-testid="pad-drop-input-1"]');
    
    // Add audio to both pads using setInputFiles
    await firstPadInput.setInputFiles(firstAudioFilePath);
    await secondPadInput.setInputFiles(secondAudioFilePath);
    
    // Verify both pads show the file name
    await expect(firstPad).toContainText(firstAudioFileName, { timeout: 5000 });
    await expect(secondPad).toContainText(secondAudioFileName, { timeout: 5000 });
    
    // Play both pads
    await firstPad.click();
    await secondPad.click();
    
    // Verify both are playing (active tracks panel should show both, using data-testid)
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');
    await expect(activeTracksPanel).toBeVisible(); // Wait for the panel itself first
    
    // Check both tracks are listed in the activeTracksPanel
    await expect(activeTracksPanel.getByText(firstAudioFileName)).toHaveCount(1);
    await expect(activeTracksPanel.getByText(secondAudioFileName)).toHaveCount(1);

    // Get the activeTrack entry for the first audio file and click it to stop playback.
    await activeTracksPanel.getByLabel('Stop playing test-audio-1').first().click();
    
    // Verify the first track stopped but the second is still playing
    // Now there should be only 1 track in the list with that name
    await expect(activeTracksPanel.getByText(firstAudioFileName)).toHaveCount(0);;
    await expect(activeTracksPanel.getByText(secondAudioFileName)).toHaveCount(1);

    // First pad's progress bar should be gone, second one still visible
    await expect(firstPad.locator('.bg-green-500')).not.toBeVisible();
    await expect(secondPad.locator('.bg-green-500')).toBeVisible();
  });
  

  // TODO: Test fadeout 
  // YOu can get the fadeout button once it's playing using (getByRole('button', { name: 'Fade out test-audio' }))


  test('Can load audio file onto pad using file input', async ({ page }) => {
    const expectedFileName = 'test-audio';

    // Create a temporary test audio file path
    const audioFilePath = await createTestAudioFilePath(expectedFileName);
    
    // Get an empty pad and its input
    const emptyPad = page.locator('[id^="pad-"]').first();
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    
    // Initially, pad should show "Empty Pad"
    await expect(emptyPad).toContainText('Empty Pad');
    
    // Add audio to the pad using setInputFiles
    await padInput.setInputFiles(audioFilePath);
    
    // Verify the pad now shows the file name instead of "Empty Pad"
    await expect(emptyPad).toContainText(expectedFileName, { timeout: 5000 });
    await expect(emptyPad).not.toContainText('Empty Pad');
  });
});
