import { test, expect, Page } from "@playwright/test";
import { prepareAudioContext } from "./test-helpers";
import { DEFAULT_BACKUP_REMINDER_PERIOD_MS } from "../src/lib/db";

// Updates the named profile's backup-related fields directly in IndexedDB, so
// tests can simulate an overdue/recent backup without going through the UI.
async function setProfileBackupState(
  page: Page,
  profileName: string,
  patch: {
    lastBackedUpAt: number;
    backupReminderPeriod: number;
    updatedAt: Date;
  },
  options: { backdateFieldsModified?: boolean } = {},
) {
  await page.evaluate(
    (args) => {
      const { profileName, patch, backdateFieldsModified } = args;
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("impamp3DB");

        request.onerror = () => {
          console.error("DB error:", request.error);
          reject(new Error(`IndexedDB error: ${request.error?.message}`));
        };

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains("profiles")) {
            db.close();
            reject(new Error("Profiles object store not found"));
            return;
          }
          const transaction = db.transaction("profiles", "readwrite");
          const store = transaction.objectStore("profiles");
          const index = store.index("name");
          const getRequest = index.get(profileName);

          getRequest.onsuccess = () => {
            const profile = getRequest.result;
            if (!profile) {
              reject(new Error(`Profile "${profileName}" not found`));
              return;
            }

            Object.assign(profile, patch);
            if (backdateFieldsModified && profile._fieldsModified) {
              const backdated: Record<string, number> = {};
              for (const key of Object.keys(profile._fieldsModified)) {
                backdated[key] = patch.lastBackedUpAt - 1000;
              }
              profile._fieldsModified = backdated;
            }

            const putRequest = store.put(profile);
            putRequest.onsuccess = () => {
              console.log("Profile updated successfully in evaluate");
              resolve(true);
            };
            putRequest.onerror = () => {
              console.error("Failed to put profile:", putRequest.error);
              reject(
                new Error(
                  `Failed to update profile: ${putRequest.error?.message}`,
                ),
              );
            };
          };
          getRequest.onerror = () => {
            console.error("Failed to get profile:", getRequest.error);
            reject(
              new Error(`Failed to get profile: ${getRequest.error?.message}`),
            );
          };

          transaction.oncomplete = () => {
            db.close();
          };
          transaction.onerror = () => {
            db.close();
            reject(
              new Error(`Transaction error: ${transaction.error?.message}`),
            );
          };
        };
      });
    },
    {
      profileName,
      patch,
      backdateFieldsModified: options.backdateFieldsModified ?? false,
    },
  );
}

// Backdates lastBackedUpAt past the reminder period and reloads, so the
// backup-reminder banner is showing by the time the test's assertions run.
async function makeBackupOverdueAndReload(
  page: Page,
  profileName: string,
  twoMonthsMs: number,
  oneMonthMs: number,
) {
  await setProfileBackupState(page, profileName, {
    lastBackedUpAt: Date.now() - twoMonthsMs,
    backupReminderPeriod: oneMonthMs,
    updatedAt: new Date(),
  });

  await page.reload();
  await page.waitForSelector('[id^="pad-"]');
}

test.describe("Backup Reminders", () => {
  const profileName = "Backup Test Profile";
  const oneMonthMs = DEFAULT_BACKUP_REMINDER_PERIOD_MS;
  const twoMonthsMs = 2 * oneMonthMs;

  test.beforeEach(async ({ page }) => {
    // Go to the app
    await page.goto("/");
    // Wait for the app to fully load
    await page.waitForSelector('[id^="pad-"]');
    // Prepare the audio context
    await prepareAudioContext(page);

    // --- Create a profile specifically for these tests ---
    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();
    await page.getByRole("textbox", { name: "Profile Name" }).fill(profileName);
    await page.getByRole("button", { name: /Create Profile/i }).click();
    await expect(
      page.getByRole("heading", { name: profileName }),
    ).toBeVisible();
    await page.getByLabel("Close").click();
    await expect(page.getByText(/Profile Manager/i)).toBeHidden();
    // Ensure the new profile is active
    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: profileName }).click();
    await expect(page.getByRole("button", { name: profileName })).toBeVisible();
  });

  test("Reminder appears when backup is overdue", async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue, and reload ---
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    // --- Verify the reminder notification ---
    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    ); // Use data-testid
    await expect(reminderBanner).toBeVisible({ timeout: 10000 }); // Wait longer if needed
    await expect(reminderBanner).toContainText("Backup Recommended");
    await expect(reminderBanner).toContainText(profileName);

    // Verify the "Manage Profiles" button exists within the banner
    await expect(
      reminderBanner.getByRole("button", { name: "Manage Profiles" }),
    ).toBeVisible();
  });

  test("Reminder does not appear when recent", async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup recent ---
    await setProfileBackupState(page, profileName, {
      lastBackedUpAt: Date.now() - 1000,
      backupReminderPeriod: oneMonthMs,
      updatedAt: new Date(),
    });

    // Reload the page
    await page.reload();
    await page.waitForSelector('[id^="pad-"]'); // Wait for load

    // --- Verify the reminder notification is NOT visible ---
    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    ); // Use data-testid
    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder does NOT appear when backup is overdue but no changes were made", async ({
    page,
  }) => {
    // Simulate: user backed up, then nothing changed, but time has passed
    const backedUpAt = Date.now() - twoMonthsMs;
    await setProfileBackupState(
      page,
      profileName,
      {
        lastBackedUpAt: backedUpAt,
        backupReminderPeriod: oneMonthMs,
        // updatedAt matches lastBackedUpAt — no changes since backup
        updatedAt: new Date(backedUpAt),
      },
      { backdateFieldsModified: true },
    );

    await page.reload();
    await page.waitForSelector('[id^="pad-"]');

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeHidden();
  });

  test('Reminder does not appear when set to "Never"', async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue, and reload ---
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    // Verify it's initially visible
    await expect(
      page.locator('[data-testid="backup-reminder-banner"]'),
    ).toBeVisible();

    // --- Open profile manager and set reminder to "Never" ---
    await page.getByRole("button", { name: "Manage Profiles" }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Find the profile card and click Edit
    // TODO: Uncertain if this is the best way to find the edit button for the right profile.
    await page
      .locator("div")
      .filter({ hasText: /^Edit$/ })
      .getByRole("button")
      .click();

    // Find and check the "Disable Reminder" checkbox
    await page.getByRole("checkbox", { name: "Disable Reminder" }).check();

    // Save changes
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeHidden(); // Wait for edit mode to close

    // Close manager
    await page.getByLabel("Close").click();
    await expect(page.getByText(/Profile Manager/i)).toBeHidden();

    // --- Verify the reminder notification is NOT visible ---
    // No reload needed here, the hook should react
    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder appears/disappears on setting change", async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue ---
    await setProfileBackupState(page, profileName, {
      lastBackedUpAt: Date.now() - twoMonthsMs, // Overdue
      backupReminderPeriod: -1, // Start with 'Never'
      updatedAt: new Date(),
    });

    // Reload page
    await page.reload();
    await page.waitForSelector('[id^="pad-"]');

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    ); // Use data-testid
    await expect(reminderBanner).toBeHidden(); // Should initially be hidden (set to Never)

    // --- Open profile manager and set reminder to "1 Month" ---
    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    const profileCard = page
      .locator(".border")
      .filter({ hasText: profileName })
      .first();
    await profileCard.getByRole("button", { name: "Edit" }).click();
    const reminderDaysInput = page.getByPlaceholder("e.g.,");

    // Uncheck the disable box and set days to 30 (equivalent to 1 Month)
    await page.getByRole("checkbox", { name: "Disable Reminder" }).uncheck();

    await reminderDaysInput.fill("30");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeHidden(); // Wait for edit mode to close
    await page.getByLabel("Close").click();

    // --- Verify reminder IS visible ---
    await expect(reminderBanner).toBeVisible();
    await expect(reminderBanner).toContainText(profileName);

    // --- Open profile manager and set reminder back to "Never" ---
    await page.getByRole("button", { name: "Manage Profiles" }).click();

    // Start editing the profile again
    // TODO: This might accidentally edit the wrong profile. Need to ensure the right one is selected, but not sure how.
    await page
      .locator("div")
      .filter({ hasText: /^Edit$/ })
      .getByRole("button")
      .click();
    const disableCheckboxAgain = page.locator(
      'input[id^="backupReminderDisable-"]',
    );

    // Check the disable box again
    await disableCheckboxAgain.check();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Save" })).toBeHidden();
    await page.getByLabel("Close").click();

    // --- Verify reminder is hidden again ---
    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder disappears after export", async ({ page }) => {
    // --- Modify the profile in IndexedDB to make the backup overdue, and reload ---
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeVisible(); // Verify it's initially visible

    // --- Export the profile ---
    await page.getByRole("button", { name: "Manage Profiles" }).click();
    await page.getByRole("button", { name: "Import / Export" }).click();

    // Select the profile to export
    const exportProfileSelect = await page.locator("select#exportProfile");
    await expect(exportProfileSelect).toBeVisible();
    await exportProfileSelect.selectOption("2");

    // Click the export button and wait for download
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export Profile" }).click();
    await downloadPromise; // Wait for the download to start, but don't need the result
    // Optional: Assert download filename if needed

    // Close manager
    await page.getByLabel("Close").click();

    // --- Verify the reminder notification is NOT visible after export ---
    // No reload needed, store update should trigger hook update
    await expect(reminderBanner).toBeHidden();
  });
});
