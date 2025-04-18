import { test, expect } from '@playwright/test';
import { prepareAudioContext } from './test-helpers';

test.describe('ImpAmp3 Profile Management', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto('/');
    
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    
    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test('Can create a new profile and switch to it', async ({ page }) => {
    // Find and click profile selector
    const profileSelector = await page.getByRole('button', { name: /profile/i });
    await profileSelector.click();
  
    // Open the manage profiles modal
    await page.getByRole('menuitem', { name: 'Manage Profiles' }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();
    
    // Fill in profile name
    const nameInput = page.getByRole('textbox', { name: 'Profile Name' })
    await nameInput.fill('Test Profile');
    
    // Select local sync type
    page.getByLabel('Storage Type').selectOption('Local Only');

    // Click save
    const createProfileButton = page.getByRole('button', { name: /Create Profile/i });
    await createProfileButton.click();
  
    // Verify each profile is visible
    await expect(page.getByRole('heading', { name: 'Default Local Profile' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Test Profile' })).toBeVisible();

    // Close the profile manager
    const closeButton = page.getByLabel('Close');
    closeButton.click();
    await expect(page.getByRole('heading', { name: 'Profile Manager' })).toBeHidden();
    
    // Verify the profile selector now shows the new profile
    await profileSelector.click();

    const testProfilebutton = page.getByRole('menuitem', { name: 'Test Profile' });
    await expect(testProfilebutton).toBeVisible();

    // Click on the new profile to switch to it
    testProfilebutton.click();

    // Verify the new profile is now active
    await expect(profileSelector).toContainText('Test Profile');

    // Reload the page
    await page.reload();

    // Wait for the app to load again
    await page.waitForSelector('[id^="pad-"]');

    // Verify the new profile is still active
    await expect(profileSelector).toContainText('Test Profile');
  });
  
  test('Cannot delete the active profile', async ({ page }) => {
    // Find and click profile selector
    const profileSelector = await page.getByRole('button', { name: /profile/i });
    await profileSelector.click();
  
    // Open the manage profiles modal
    await page.getByRole('menuitem', { name: 'Manage Profiles' }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Find the delete button for the active profile (assuming Default is active initially)
    const activeProfileItem = page.locator('[role="listitem"]').filter({ hasText: /Default/i }).first();
    const deleteButton = activeProfileItem.getByRole('button', { name: /delete/i });
    
    // Delete button should be hidden for active profile
    await expect(deleteButton).toBeHidden();
  });
});
