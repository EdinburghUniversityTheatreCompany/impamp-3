import { test, expect } from '@playwright/test';
import { prepareAudioContext } from './test-helpers';
import { DEFAULT_BACKUP_REMINDER_PERIOD_MS } from '../src/lib/db';

test.describe('Backup Reminders', () => {
  const profileName = 'Backup Test Profile';
  const oneMonthMs = DEFAULT_BACKUP_REMINDER_PERIOD_MS;
  const twoMonthsMs = 2 * oneMonthMs;

  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto('/');
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    // Prepare the audio context
    await prepareAudioContext(page);

    // --- Create a profile specifically for these tests ---
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('menuitem', { name: 'Manage Profiles' }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();
    await page.getByRole('textbox', { name: 'Profile Name' }).fill(profileName);
    await page.getByRole('button', { name: /Create Profile/i }).click();
    await expect(page.getByRole('heading', { name: profileName })).toBeVisible();
    await page.getByLabel('Close').click();
    await expect(page.getByText(/Profile Manager/i)).toBeHidden();
    // Ensure the new profile is active
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('menuitem', { name: profileName }).click();
    await expect(page.getByRole('button', { name: profileName })).toBeVisible();
  });

  test('Reminder appears when backup is overdue', async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue ---
    await page.evaluate( // Removed unused assignment 'const updateResult ='
      (args) => {
        // Destructure args inside the evaluate function
        const { profileName, twoMonthsMs, oneMonthMs } = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('impamp3DB'); // Use the correct DB name

          request.onerror = () => { // Removed unused _event parameter
            console.error('DB error:', request.error);
            reject(new Error(`IndexedDB error: ${request.error?.message}`));
          };

          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('profiles')) {
              db.close();
              reject(new Error('Profiles object store not found'));
              return;
            }
            const transaction = db.transaction('profiles', 'readwrite');
            const store = transaction.objectStore('profiles');
            const index = store.index('name'); // Assuming 'name' index exists
            const getRequest = index.get(profileName);

            getRequest.onsuccess = () => {
              const profile = getRequest.result;
              if (profile) {
                // Modify the profile
                profile.lastBackedUpAt = Date.now() - twoMonthsMs; // Set backup date to 2 months ago
                profile.backupReminderPeriod = oneMonthMs; // Set reminder period to 1 month
                profile.updatedAt = new Date();

                const putRequest = store.put(profile);
                putRequest.onsuccess = () => {
                  console.log('Profile updated successfully in evaluate');
                  resolve(true); // Indicate success
                };
                putRequest.onerror = () => {
                  console.error('Failed to put profile:', putRequest.error);
                  reject(
                    new Error(
                      `Failed to update profile: ${putRequest.error?.message}`,
                    ),
                  );
                };
              } else {
                reject(new Error(`Profile "${profileName}" not found`));
              }
            };
            getRequest.onerror = () => {
              console.error('Failed to get profile:', getRequest.error);
              reject(
                new Error(
                  `Failed to get profile: ${getRequest.error?.message}`,
                ),
              );
            };

            transaction.oncomplete = () => {
              db.close();
              // Resolve might have already happened in putRequest.onsuccess
            };
            transaction.onerror = () => {
              db.close();
              reject(
                new Error(
                  `Transaction error: ${transaction.error?.message}`,
                ),
              );
            };
          };
        });
      },
      { profileName, twoMonthsMs, oneMonthMs }, // Pass variables to evaluate
    );

    // Reload the page to trigger the reminder check with updated DB values
    await page.reload();
    await page.waitForSelector('[id^="pad-"]'); // Wait for load

    // --- Verify the reminder notification ---
    const reminderBanner = page.locator('[data-testid="backup-reminder-banner"]'); // Use data-testid
    await expect(reminderBanner).toBeVisible({ timeout: 10000 }); // Wait longer if needed
    await expect(reminderBanner).toContainText('Backup Recommended');
    await expect(reminderBanner).toContainText(profileName);

    // Verify the "Manage Profiles" button exists within the banner
    await expect(
      reminderBanner.getByRole('button', { name: 'Manage Profiles' }),
    ).toBeVisible();
  });

  test('Reminder does not appear when recent', async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup recent ---
    await page.evaluate(
      (args) => {
        const { profileName, oneMonthMs } = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('impamp3DB');
          request.onerror = () => reject(new Error(`IndexedDB error: ${request.error?.message}`));
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('profiles')) {
              db.close();
              return reject(new Error('Profiles object store not found'));
            }
            const transaction = db.transaction('profiles', 'readwrite');
            const store = transaction.objectStore('profiles');
            const index = store.index('name');
            const getRequest = index.get(profileName);

            getRequest.onsuccess = () => {
              const profile = getRequest.result;
              if (profile) {
                profile.lastBackedUpAt = Date.now() - 1000; // Set backup date to 1 second ago
                profile.backupReminderPeriod = oneMonthMs; // Ensure reminder period is active
                profile.updatedAt = new Date();
                const putRequest = store.put(profile);
                putRequest.onsuccess = () => resolve(true);
                putRequest.onerror = () => reject(new Error(`Failed to update profile: ${putRequest.error?.message}`));
              } else {
                reject(new Error(`Profile "${profileName}" not found`));
              }
            };
            getRequest.onerror = () => reject(new Error(`Failed to get profile: ${getRequest.error?.message}`));
            transaction.oncomplete = () => db.close();
            transaction.onerror = () => reject(new Error(`Transaction error: ${transaction.error?.message}`));
          };
        });
      },
      { profileName, oneMonthMs },
    );

    // Reload the page
    await page.reload();
    await page.waitForSelector('[id^="pad-"]'); // Wait for load

    // --- Verify the reminder notification is NOT visible ---
    const reminderBanner = page.locator('[data-testid="backup-reminder-banner"]'); // Use data-testid
    await expect(reminderBanner).toBeHidden();
  });

  test('Reminder does not appear when set to "Never"', async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue ---
    // (Same evaluate logic as 'Reminder appears when backup is overdue' test)
    await page.evaluate(
      (args) => {
        const { profileName, twoMonthsMs, oneMonthMs } = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('impamp3DB');
          request.onerror = () => reject(new Error(`IndexedDB error: ${request.error?.message}`));
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('profiles')) { db.close(); return reject(new Error('Profiles object store not found')); }
            const transaction = db.transaction('profiles', 'readwrite');
            const store = transaction.objectStore('profiles');
            const index = store.index('name');
            const getRequest = index.get(profileName);
            getRequest.onsuccess = () => {
              const profile = getRequest.result;
              if (profile) {
                profile.lastBackedUpAt = Date.now() - twoMonthsMs; // Overdue
                profile.backupReminderPeriod = oneMonthMs; // Default period initially
                profile.updatedAt = new Date();
                const putRequest = store.put(profile);
                putRequest.onsuccess = () => resolve(true);
                putRequest.onerror = () => reject(new Error(`Failed to update profile: ${putRequest.error?.message}`));
              } else { reject(new Error(`Profile "${profileName}" not found`)); }
            };
            getRequest.onerror = () => reject(new Error(`Failed to get profile: ${getRequest.error?.message}`));
            transaction.oncomplete = () => db.close();
            transaction.onerror = () => reject(new Error(`Transaction error: ${transaction.error?.message}`));
          };
        });
      },
      { profileName, twoMonthsMs, oneMonthMs },
    );

    // Reload to ensure the profile is initially overdue
    await page.reload();
    await page.waitForSelector('[id^="pad-"]');
    await expect(page.locator('[data-testid="backup-reminder-banner"]')).toBeVisible(); // Use data-testid & Verify it's initially visible

    // --- Open profile manager and set reminder to "Never" ---
    await page.getByRole('button', { name: 'Manage Profiles' }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Find the profile card and click Edit
    // TODO: Uncertain if this is the best way to find the edit button for the right profile.
    await page.locator('div').filter({ hasText: /^Edit$/ }).getByRole('button').click();

    // Find and check the "Disable Reminder" checkbox
    await page.getByRole('checkbox', { name: 'Disable Reminder' }).check();

    // Save changes
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: 'Save' })).toBeHidden(); // Wait for edit mode to close

    // Close manager
    await page.getByLabel('Close').click();
    await expect(page.getByText(/Profile Manager/i)).toBeHidden();

    // --- Verify the reminder notification is NOT visible ---
    // No reload needed here, the hook should react
    const reminderBanner = page.locator('[data-testid="backup-reminder-banner"]');
    await expect(reminderBanner).toBeHidden();
  });

  test('Reminder appears/disappears on setting change', async ({ page }) => {
     // --- Modify the profile in IndexedDB to make the backup overdue ---
     await page.evaluate(
      (args) => {
        const { profileName, twoMonthsMs } = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('impamp3DB');
          request.onerror = () => reject(new Error(`IndexedDB error: ${request.error?.message}`));
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('profiles')) { db.close(); return reject(new Error('Profiles object store not found')); }
            const transaction = db.transaction('profiles', 'readwrite');
            const store = transaction.objectStore('profiles');
            const index = store.index('name');
            const getRequest = index.get(profileName);
            getRequest.onsuccess = () => {
              const profile = getRequest.result;
              if (profile) {
                profile.lastBackedUpAt = Date.now() - twoMonthsMs; // Overdue
                profile.backupReminderPeriod = -1; // Start with 'Never'
                profile.updatedAt = new Date();
                const putRequest = store.put(profile);
                putRequest.onsuccess = () => resolve(true);
                putRequest.onerror = () => reject(new Error(`Failed to update profile: ${putRequest.error?.message}`));
              } else { reject(new Error(`Profile "${profileName}" not found`)); }
            };
            getRequest.onerror = () => reject(new Error(`Failed to get profile: ${getRequest.error?.message}`));
            transaction.oncomplete = () => db.close();
            transaction.onerror = () => reject(new Error(`Transaction error: ${transaction.error?.message}`));
          };
        });
      },
      { profileName, twoMonthsMs },
    );

    // Reload page
    await page.reload();
    await page.waitForSelector('[id^="pad-"]');

    const reminderBanner = page.locator('[data-testid="backup-reminder-banner"]'); // Use data-testid
    await expect(reminderBanner).toBeHidden(); // Should initially be hidden (set to Never)

    // --- Open profile manager and set reminder to "1 Month" ---
    await page.getByRole('button', { name: /profile/i }).click();
    await page.getByRole('menuitem', { name: 'Manage Profiles' }).click();
    const profileCard = page.locator('.border').filter({ hasText: profileName }).first();
    await profileCard.getByRole('button', { name: 'Edit' }).click();
    const reminderDaysInput = page.getByPlaceholder('e.g.,');

    // Uncheck the disable box and set days to 30 (equivalent to 1 Month)
    await page.getByRole('checkbox', { name: 'Disable Reminder' }).uncheck();

    await reminderDaysInput.fill('30');

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: 'Save' })).toBeHidden(); // Wait for edit mode to close
    await page.getByLabel('Close').click();

    // --- Verify reminder IS visible ---
    await expect(reminderBanner).toBeVisible();
    await expect(reminderBanner).toContainText(profileName);

     // --- Open profile manager and set reminder back to "Never" ---
     await page.getByRole('button', { name: 'Manage Profiles' }).click();

     // Start editing the profile again
     // TODO: This might accidentally edit the wrong profile. Need to ensure the right one is selected, but not sure how.
     await page.locator('div').filter({ hasText: /^Edit$/ }).getByRole('button').click();
     const disableCheckboxAgain = page.locator('input[id^="backupReminderDisable-"]');

     // Check the disable box again
     await disableCheckboxAgain.check();

     await page.getByRole('button', { name: 'Save' }).click();
     await expect(page.getByRole('button', { name: 'Save' })).toBeHidden();
     await page.getByLabel('Close').click();

     // --- Verify reminder is hidden again ---
     await expect(reminderBanner).toBeHidden();
  });

  test('Reminder disappears after export', async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue ---
    // (Same evaluate logic as 'Reminder appears when backup is overdue' test)
    await page.evaluate(
      (args) => {
        const { profileName, twoMonthsMs, oneMonthMs } = args;
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('impamp3DB');
          request.onerror = () => reject(new Error(`IndexedDB error: ${request.error?.message}`));
          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains('profiles')) { db.close(); return reject(new Error('Profiles object store not found')); }
            const transaction = db.transaction('profiles', 'readwrite');
            const store = transaction.objectStore('profiles');
            const index = store.index('name');
            const getRequest = index.get(profileName);
            getRequest.onsuccess = () => {
              const profile = getRequest.result;
              if (profile) {
                profile.lastBackedUpAt = Date.now() - twoMonthsMs; // Overdue
                profile.backupReminderPeriod = oneMonthMs; // Default period
                profile.updatedAt = new Date();
                const putRequest = store.put(profile);
                putRequest.onsuccess = () => resolve(true);
                putRequest.onerror = () => reject(new Error(`Failed to update profile: ${putRequest.error?.message}`));
              } else { reject(new Error(`Profile "${profileName}" not found`)); }
            };
            getRequest.onerror = () => reject(new Error(`Failed to get profile: ${getRequest.error?.message}`));
            transaction.oncomplete = () => db.close();
            transaction.onerror = () => reject(new Error(`Transaction error: ${transaction.error?.message}`));
          };
        });
      },
      { profileName, twoMonthsMs, oneMonthMs },
    );

     // Reload page
     await page.reload();
     await page.waitForSelector('[id^="pad-"]');

     const reminderBanner = page.locator('[data-testid="backup-reminder-banner"]');
     await expect(reminderBanner).toBeVisible(); // Verify it's initially visible

     // --- Export the profile ---
     await page.getByRole('button', { name: 'Manage Profiles' }).click();
     await page.getByRole('button', { name: 'Import / Export' }).click();

     // Select the profile to export
     const exportProfileSelect = await page.locator('select#exportProfile')
     await expect(exportProfileSelect).toBeVisible();
     await exportProfileSelect.selectOption('2');

     // Click the export button and wait for download
     const downloadPromise = page.waitForEvent('download');
     await page.getByRole('button', { name: 'Export Profile' }).click();
     await downloadPromise; // Wait for the download to start, but don't need the result
     // Optional: Assert download filename if needed

     // Close manager
     await page.getByLabel('Close').click();

     // --- Verify the reminder notification is NOT visible after export ---
     // No reload needed, store update should trigger hook update
     await expect(reminderBanner).toBeHidden();
  });
});
