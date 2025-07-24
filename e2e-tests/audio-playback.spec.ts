import { test, expect, Page } from '@playwright/test';
import {
  createTestAudioFilePath,
  prepareAudioContext,
  createMultipleTestAudioFiles,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
  setPlaybackModeInModal,
  getPlayingSoundNames,
} from './test-helpers';
import { ActivePadBehavior, PlaybackType } from '../src/lib/db';

// Helper function to set the Active Pad Behavior setting via the UI
async function setActivePadBehaviorSetting(page: Page, behavior: ActivePadBehavior) {
  const settingsButton = page.locator('[data-testid="active-tracks-panel"] button[aria-label="Fadeout settings"]');
  await settingsButton.click();

  const modal = page.locator('.fixed.inset-0.bg-black\\/50');
  await expect(modal).toBeVisible();

  const behaviorRadioButton = modal.locator(`input[name="activePadBehavior"][value="${behavior}"]`);
  await expect(behaviorRadioButton).toBeVisible();
  await behaviorRadioButton.click();

  const saveButton = modal.locator('button:has-text("Save Settings")');
  await saveButton.click();

  await expect(modal).not.toBeVisible(); // Wait for modal to close
  console.log(`[Test Helper] Set activePadBehavior to: ${behavior}`);
}

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

  // --- Tests for Active Pad Behavior ---

  test('Active Pad Behavior: "continue" keeps sound playing', async ({ page }) => {
    const fileName = 'continue-test';
    const audioFilePath = await createTestAudioFilePath(fileName);
    const pad = page.locator('[id^="pad-"]').first();
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');

    // Set behavior
    await setActivePadBehaviorSetting(page, 'continue');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(pad).toContainText(fileName, { timeout: 5000 });

    // Play
    await pad.click();
    await expect(pad.locator('.bg-green-500')).toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();

    // Click again while playing
    await pad.click();
    await page.waitForTimeout(200); // Allow time for potential state changes

    // Assert still playing
    await expect(pad.locator('.bg-green-500')).toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();
  });

  test('Active Pad Behavior: "stop" stops the sound', async ({ page }) => {
    const fileName = 'stop-test';
    const audioFilePath = await createTestAudioFilePath(fileName);
    const pad = page.locator('[id^="pad-"]').first();
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');

    // Set behavior
    await setActivePadBehaviorSetting(page, 'stop');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(pad).toContainText(fileName, { timeout: 5000 });

    // Play
    await pad.click();
    await expect(pad.locator('.bg-green-500')).toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();

    // Click again while playing
    await pad.click();

    // Assert stopped
    await expect(pad.locator('.bg-green-500')).not.toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).not.toBeVisible();
  });

  test('Active Pad Behavior: "restart" restarts the sound', async ({ page }) => {
    const fileName = 'restart-test';
    const audioFilePath = await createTestAudioFilePath(fileName);
    const pad = page.locator('[id^="pad-"]').first();
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    const activeTracksPanel = page.locator('[data-testid="active-tracks-panel"]');

    // Set behavior
    await setActivePadBehaviorSetting(page, 'restart');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(pad).toContainText(fileName, { timeout: 5000 });

    // Play
    await pad.click();
    await expect(pad.locator('.bg-green-500')).toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();

    // Click again while playing
    await pad.click();
    await page.waitForTimeout(200); // Allow time for potential state changes

    // Assert still playing (indicating restart happened)
    await expect(pad.locator('.bg-green-500')).toBeVisible();
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();
    // Note: Verifying progress reset is harder, but checking playing state is a good indicator.
  });

  // --- Tests for Multi-Sound Drag and Drop --
  // TODO: This feature currently doesn't seem to work
    test('prevents dropping onto pad with >1 sound', async ({ page }) => {
        const fileNames = ['multiDropA', 'multiDropB'];
        const filePaths = await createMultipleTestAudioFiles(fileNames);
        const thirdSound = 'multiDropC';
        const thirdFilePath = await createTestAudioFilePath(thirdSound);

        // Configure pad 8 with two sounds using the modal
        await openEditPadModal(page, 8);
        await addSoundsToPadModal(page, filePaths);
        await savePadEditModal(page);

        // Verify the pad shows the first sound name
        const pad = page.locator('[id^="pad-"][id$="-8"]');
        await expect(pad).toContainText(fileNames[0]);

        // Attempt to drag the third sound onto the pad
        const dataTransfer = await page.evaluateHandle((filePath) => {
            const dt = new DataTransfer();
            const file = new File(['dummy content'], filePath.split('/').pop() || 'test.wav', { type: 'audio/wav' });
            dt.items.add(file);
            return dt;
        }, thirdFilePath);

        // Dispatch drag events
        await pad.dispatchEvent('dragenter', { dataTransfer });
        await page.waitForTimeout(100); // Short delay for visual feedback

        // Verify rejection overlay/message appears
        await expect(pad.locator('text=Cannot drop here')).toBeVisible();

        // Dispatch drop event (even though it should be rejected)
        await pad.dispatchEvent('drop', { dataTransfer });
        await page.waitForTimeout(200); // Wait for potential (incorrect) updates

        // Verify pad name HAS NOT changed to the third sound
        await expect(pad).toContainText(fileNames[0]);
        await expect(pad).not.toContainText(thirdSound);

        // Optional: Re-open modal and verify only the original two sounds are present
        await openEditPadModal(page, 8);
        await expect(page.locator('[data-testid^="edit-pad-sound-item-"]')).toHaveCount(2);
        await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[0]}")`)).toBeVisible();
        await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`)).toBeVisible();
        await expect(page.locator(`[data-testid^="edit-pad-sound-item-"]:has-text("${thirdSound}")`)).not.toBeVisible();
    });

  // --- Tests for Multi-Sound Playback Modes ---
  test.describe('Multi-Sound Playback Modes', () => {
    // Helper to configure a pad with multiple sounds and specific mode
    async function configureMultiSoundPad(page: Page, padIndex: number, fileNames: string[], mode: PlaybackType) {
        const filePaths = await createMultipleTestAudioFiles(fileNames);
        await openEditPadModal(page, padIndex);
        await addSoundsToPadModal(page, filePaths);
        await setPlaybackModeInModal(page, mode);
        await savePadEditModal(page);
        console.log(`[Test Setup] Configured pad ${padIndex} with sounds [${fileNames.join(', ')}] in ${mode} mode.`);
    }

    test('Sequential mode plays sounds in order (with state persistence)', async ({ page }) => {
        const padIndex = 9;
        const fileNames = ['seqA', 'seqB', 'seqC'];
        await configureMultiSoundPad(page, padIndex, fileNames, 'sequential');
        const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);

        // Trigger 1 -> A
        await pad.click();
        await expect(page.getByTestId('active-tracks-panel').getByText('seqA')).toBeVisible({ timeout: 2000 });
        
        await expect(await getPlayingSoundNames(page)).toEqual([fileNames[0]])

        // Trigger 2 -> B
        await pad.click();
        await expect(page.getByTestId('active-tracks-panel').getByText('seqA')).toBeVisible({ timeout: 2000 });
        await expect(await getPlayingSoundNames(page)).toEqual([fileNames[1]]);

        // Trigger 3 -> C
        await pad.click();
        await expect(page.getByTestId('active-tracks-panel').getByText('seqA')).toBeVisible({ timeout: 2000 });
        await expect(await getPlayingSoundNames(page)).toEqual([fileNames[2]]);

        // Trigger 4 -> A (Wrap around)
        await pad.click();
        await expect(page.getByTestId('active-tracks-panel').getByText('seqA')).toBeVisible({ timeout: 2000 });
        await expect(await getPlayingSoundNames(page)).toEqual([fileNames[0]]);

        // Stop sound A
        await page.getByTestId('active-tracks-panel').getByText('seqA').click();
        await expect(page.locator('text=Nothing playing')).toBeVisible(); // Wait for stop

        // Trigger 5 -> Should play B (state preserved on stop)
        await pad.click();
        await expect(page.getByTestId('active-tracks-panel').getByText('seqA')).toBeVisible({ timeout: 2000 });
        await expect(await getPlayingSoundNames(page)).toEqual([fileNames[1]]);
    });

    test('Random mode plays sounds randomly', async ({ page }) => {
        const padIndex = 10;
        const fileNames = ['randA', 'randB', 'randC'];
        await configureMultiSoundPad(page, padIndex, fileNames, 'random');
        const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);
        const playedSounds: string[] = [];

        // Trigger multiple times
        for (let i = 0; i < 15; i++) {
            await pad.click();
            // Wait briefly for active track panel to update
            await page.waitForTimeout(100);
            const currentPlaying = await getPlayingSoundNames(page);
            // Expect only one sound playing at a time for this test setup
            expect(currentPlaying.length).toBeLessThanOrEqual(1);
            if (currentPlaying.length === 1) {
                playedSounds.push(currentPlaying[0]);
                // Stop the sound before next trigger to avoid overlap issues in test
                 await page.getByTestId('active-tracks-panel').getByText('randA').click();
                 await expect(page.locator('text=Nothing playing')).toBeVisible(); // Wait for stop
            }
             await page.waitForTimeout(50); // Small delay between triggers
        }

        console.log('Random mode played sounds:', playedSounds);
        // Assert all played sounds are from the expected list
        playedSounds.forEach(sound => expect(fileNames).toContain(sound));
        // Assert that at least two different sounds were played (high probability)
        const uniquePlayed = new Set(playedSounds);
        expect(uniquePlayed.size).toBeGreaterThan(1);
    });

     test('Round-Robin mode plays all sounds before repeating (with state persistence)', async ({ page }) => {
        const padIndex = 11;
        const fileNames = ['rrA', 'rrB', 'rrC'];
        await configureMultiSoundPad(page, padIndex, fileNames, 'round-robin');
        const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);
        const playedSoundsCycle1: string[] = []; // Use const as it's only populated, not reassigned

        // Trigger 3 times, collect results
        for (let i = 0; i < fileNames.length; i++) {
            await pad.click();
            await page.waitForTimeout(100);
            const currentPlaying = await getPlayingSoundNames(page);
            expect(currentPlaying.length).toBe(1);
            playedSoundsCycle1.push(currentPlaying[0]);
            // Stop the sound
            await page.getByTestId('active-tracks-panel').getByText('rrA').click();
            await expect(page.locator('text=Nothing playing')).toBeVisible();
            await page.waitForTimeout(50);
        }

        console.log('Round-Robin Cycle 1 played:', playedSoundsCycle1);
        // Assert all sounds played exactly once in the first cycle
        expect(playedSoundsCycle1.sort()).toEqual(fileNames.sort());

        // Trigger 4th time - should start a new cycle
        await pad.click();
        await page.waitForTimeout(100);
        let currentPlaying = await getPlayingSoundNames(page);
        expect(currentPlaying.length).toBe(1);
        expect(fileNames).toContain(currentPlaying[0]);
        const fourthSound = currentPlaying[0];
        console.log('Round-Robin 4th sound:', fourthSound);

         // Stop sound B (assuming it played in cycle 1)
         await page.getByTestId('active-tracks-panel').getByText('rrA').click();
         await expect(page.locator('text=Nothing playing')).toBeVisible(); // Wait for stop

        // Stop sound A (assuming it played in cycle 1) - simulate stopping another sound mid-cycle
        // We need to know which sounds *haven't* played in the *new* cycle.
        // Let's re-trigger until we get a different sound to stop, demonstrating state persistence.
        let fifthSound = '';
        for (let i=0; i<5; i++) { // Try a few times
            await pad.click();
            await page.waitForTimeout(100);
            currentPlaying = await getPlayingSoundNames(page);
            expect(currentPlaying.length).toBe(1);
            fifthSound = currentPlaying[0];
             await page.getByTestId('active-tracks-panel').getByText('rrA').click();
             await expect(page.locator('text=Nothing playing')).toBeVisible();
             if (fifthSound !== fourthSound) break; // Stop once we get a different one
             await page.waitForTimeout(50);
        }
        console.log('Round-Robin 5th sound:', fifthSound);
        expect(fifthSound).not.toEqual(fourthSound); // Ensure we got a different sound

        // Trigger again - should play the remaining sound from the cycle
        await pad.click();
        await page.waitForTimeout(100);
        currentPlaying = await getPlayingSoundNames(page);
        expect(currentPlaying.length).toBe(1);
        const sixthSound = currentPlaying[0];
        console.log('Round-Robin 6th sound:', sixthSound);
        expect(fileNames).toContain(sixthSound);
        expect(sixthSound).not.toEqual(fourthSound);
        expect(sixthSound).not.toEqual(fifthSound); // Should be the last remaining sound
    });
  });

});
