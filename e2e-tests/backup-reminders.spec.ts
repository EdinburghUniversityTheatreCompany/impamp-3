import { test, expect, Page } from "@playwright/test";
import { prepareAudioContext, gotoApp, waitForAppReady } from "./test-helpers";
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

/**
 * Re-read the profiles from IndexedDB into the store, without a reload.
 *
 * The helper above writes straight to the database, which nothing in the app
 * is watching — so a test that wants the reminder rules re-evaluated either
 * reloads (and gets a fresh page whose banner is absent for a moment whatever
 * the rules say) or asks the store to re-read, which re-runs the sweep in a
 * page that has already shown its answer once. The second is what lets a
 * "the reminder does not appear" test assert a *transition* rather than a
 * state that was already true.
 */
async function refetchProfiles(page: Page) {
  await page.evaluate(async () => {
    const store = (
      window as unknown as {
        __profileStore?: { getState(): { fetchProfiles(): Promise<void> } };
      }
    ).__profileStore;
    if (!store) {
      throw new Error(
        "__profileStore hook is missing — the server under test must be built with NEXT_PUBLIC_E2E_HOOKS=1",
      );
    }
    await store.getState().fetchProfiles();
  });
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
  await waitForAppReady(page);
}

// Opens the Profile Manager. When the reminder banner is showing it offers its
// own "Manage Profiles" button, and a /profile/i lookup would match both that
// and the header button, so go through whichever one is actually on screen.
async function openProfileManager(page: Page) {
  const banner = page.locator('[data-testid="backup-reminder-banner"]');
  if (await banner.isVisible()) {
    await banner.getByRole("button", { name: "Manage Profiles" }).click();
  } else {
    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeVisible();
}

async function closeProfileManager(page: Page) {
  await page.getByLabel("Close").click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeHidden();
}

// Edits one profile's backup reminder through the Profile Manager. Pass a
// number of days, or "never" to tick "Disable Reminders". Assumes the Profile
// Manager is already open.
async function setBackupReminder(
  page: Page,
  profileName: string,
  days: number | "never",
) {
  const card = page.locator(
    `[data-testid="profile-card"][data-profile-name="${profileName}"]`,
  );
  await card.getByRole("button", { name: "Edit Profile" }).click();
  await expect(page.locator('[data-testid="modal-title"]')).toContainText(
    `Edit Profile: ${profileName}`,
  );

  const disableReminders = page.locator("#disableReminders");
  if (days === "never") {
    await disableReminders.check();
  } else {
    // The period input ignores edits while the profile is disabled, so clear
    // the checkbox before typing.
    await disableReminders.uncheck();
    await page.locator("#backupReminderPeriod").fill(String(days));
  }

  await page.locator('[data-testid="modal-confirm-button"]').click();
  await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
}

test.describe("Backup Reminders", () => {
  const profileName = "Backup Test Profile";
  const oneMonthMs = DEFAULT_BACKUP_REMINDER_PERIOD_MS;
  const twoMonthsMs = 2 * oneMonthMs;

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
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
    await expect(reminderBanner).toBeVisible();
    await expect(reminderBanner).toContainText("Backup Recommended");
    await expect(reminderBanner).toContainText(profileName);

    // Verify the "Manage Profiles" button exists within the banner
    await expect(
      reminderBanner.getByRole("button", { name: "Manage Profiles" }),
    ).toBeVisible();
  });

  /**
   * The three "does not appear" cases below used to be
   * `reload()` → `waitForAppReady()` → `toBeHidden()`.
   *
   * `waitForAppReady` returns as soon as a profile is active and one bank tab
   * is visible; the reminder is decided after that, by an effect that reads
   * `lastBackedUpAt` and then runs two IndexedDB scans. The banner is absent
   * for that whole window whatever the rules say, and `toBeHidden` resolves on
   * its first poll — so a regression that removed the suppression entirely and
   * merely rendered the banner one frame later would have passed. These are
   * exactly the tests that state the rules.
   *
   * So each starts from a *visible* banner, in the same page load, and then
   * applies the thing that should suppress it. The banner going away is an
   * observable transition; it cannot be satisfied by the sweep not having run.
   */
  test("Reminder does not appear when recent", async ({ page }) => {
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    // The sweep has run and this profile is in it, which is what makes the
    // absence below mean "the rule fired" rather than "nothing has happened".
    await expect(reminderBanner).toBeVisible();

    // --- Now the backup is recent ---
    await setProfileBackupState(page, profileName, {
      lastBackedUpAt: Date.now() - 1000,
      backupReminderPeriod: oneMonthMs,
      updatedAt: new Date(),
    });
    await refetchProfiles(page);

    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder does NOT appear when backup is overdue but no changes were made", async ({
    page,
  }) => {
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeVisible();

    // Same overdue backup, but nothing has been touched since it was taken.
    // Only the second half of the rule has changed, so the banner going away
    // isolates "and something changed since" from "and it is overdue".
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
    await refetchProfiles(page);

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

    // --- Turn the reminder off for this profile ---
    await openProfileManager(page);
    await setBackupReminder(page, profileName, "never");
    await closeProfileManager(page);

    // --- Verify the reminder notification is NOT visible ---
    // No reload needed here, the hook should react
    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder appears/disappears on setting change", async ({ page }) => {
    // Overdue and changed, so the banner is up — and the sweep has demonstrably
    // run in this page load before anything is asserted about its absence.
    await makeBackupOverdueAndReload(
      page,
      profileName,
      twoMonthsMs,
      oneMonthMs,
    );

    const reminderBanner = page.locator(
      '[data-testid="backup-reminder-banner"]',
    );
    await expect(reminderBanner).toBeVisible();

    // --- Now set the period to 'Never', still overdue ---
    await setProfileBackupState(page, profileName, {
      lastBackedUpAt: Date.now() - twoMonthsMs, // Overdue
      backupReminderPeriod: -1, // 'Never'
      updatedAt: new Date(),
    });
    await refetchProfiles(page);

    await expect(reminderBanner).toBeHidden();

    // --- Set the reminder to 30 days, which the backup is well past ---
    await openProfileManager(page);
    await setBackupReminder(page, profileName, 30);
    await closeProfileManager(page);

    // --- Verify reminder IS visible ---
    await expect(reminderBanner).toBeVisible();
    await expect(reminderBanner).toContainText(profileName);

    // --- Set the reminder back to "Never" ---
    await openProfileManager(page);
    await setBackupReminder(page, profileName, "never");
    await closeProfileManager(page);

    // --- Verify reminder is hidden again ---
    await expect(reminderBanner).toBeHidden();
  });

  test("Reminder disappears after export", async ({ page }) => {
    // Force the in-memory blob download fallback: the File System Access API
    // save dialog is a native dialog Playwright cannot drive, while the
    // fallback surfaces as an ordinary download event. Registered before the
    // reload below so it is in place when the page next loads.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });

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
    await openProfileManager(page);
    await page.getByRole("button", { name: "Import / Export" }).click();

    // Select this profile in the export list. The active profile's label
    // carries an "(Active)" suffix, so match on the name as a substring.
    const exportSection = page.locator("section", {
      hasText: "Export Profiles",
    });
    await exportSection.getByRole("checkbox", { name: profileName }).check();

    // Click the export button and wait for download
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Export Selected/ }).click();
    await downloadPromise; // Wait for the download to start, but don't need the result

    await closeProfileManager(page);

    // --- Verify the reminder notification is NOT visible after export ---
    // Exporting stamps lastBackedUpAt, so the store update alone should hide
    // the banner — no reload.
    await expect(reminderBanner).toBeHidden();
  });
});
