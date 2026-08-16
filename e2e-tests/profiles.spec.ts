import { test, expect } from "@playwright/test";
import {
  prepareAudioContext,
  gotoApp,
  waitForAppReady,
  createAndSwitchToProfile,
  openProfileManager,
} from "./test-helpers";

test.describe("ImpAmp3 Profile Management", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);

    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test("the profile selector names its purpose, not just the profile", async ({
    page,
  }) => {
    // Its visible label is only the active profile's name, which says nothing
    // about what the control does and collides with any pad or armed-track
    // button named after a similar sound.
    const selector = page.getByRole("button", {
      name: /^Profile: Default Local Profile$/,
    });
    await expect(selector).toBeVisible();
    // The visible text is still part of the accessible name (WCAG 2.5.3).
    await expect(selector).toContainText("Default Local Profile");
  });

  test("Can create a new profile and switch to it", async ({ page }) => {
    // Find and click profile selector
    const profileSelector = await page.getByRole("button", {
      name: /profile/i,
    });
    await profileSelector.click();

    // Open the manage profiles modal
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Fill in profile name
    const nameInput = page.getByRole("textbox", { name: "Profile Name" });
    await nameInput.fill("Test Profile");

    // No storage-type control any more: the manager creates local profiles,
    // and linking one to Google Drive is a separate action on the profile card.

    // Click save
    const createProfileButton = page.getByRole("button", {
      name: /Create Profile/i,
    });
    await createProfileButton.click();

    // Verify each profile is visible
    await expect(
      page.getByRole("heading", { name: "Default Local Profile" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Test Profile" }),
    ).toBeVisible();

    // Close the profile manager
    const closeButton = page.getByLabel("Close");
    await closeButton.click();
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeHidden();

    // Verify the profile selector now shows the new profile
    await profileSelector.click();

    const testProfilebutton = page.getByRole("menuitem", {
      name: "Test Profile",
    });
    await expect(testProfilebutton).toBeVisible();

    // Click on the new profile to switch to it
    await testProfilebutton.click();

    // Verify the new profile is now active
    await expect(profileSelector).toContainText("Test Profile");

    // Reload the page
    await page.reload();
    await waitForAppReady(page);

    // Verify the new profile is still active
    await expect(profileSelector).toContainText("Test Profile");
  });

  test("Cannot delete the active profile, but can delete another", async ({
    page,
  }) => {
    // This used to look for `[role="listitem"]`, which appears nowhere in the
    // app — ProfileManager renders ProfileCards inside plain divs. toBeHidden()
    // passes on an element that does not exist, so the test passed whatever the
    // app did, including the regression it exists to catch.
    //
    // It also asserted only the negative half. Deleting the guard would still
    // leave "no Delete button on the active card" true if the button vanished
    // for some unrelated reason, so the positive half is asserted too: the card
    // that *is* deletable has to have one.
    await createAndSwitchToProfile(page, "Second Profile");

    await openProfileManager(page);

    const activeCard = page
      .getByTestId("profile-card")
      .filter({ hasText: "Second Profile" });
    const inactiveCard = page
      .getByTestId("profile-card")
      .filter({ hasText: "Default" });

    await expect(activeCard).toBeVisible();
    await expect(inactiveCard).toBeVisible();

    await expect(
      activeCard.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    await expect(
      inactiveCard.getByRole("button", { name: "Delete", exact: true }),
    ).toBeVisible();
  });

  test("Can import an impamp2 profile file", async ({ page }) => {
    // Minimal valid impamp2 data structure
    const impamp2ProfileData = {
      padCount: 1,
      pages: {
        "0": {
          pageNo: "0",
          name: "Impamp2 Test Page",
          emergencies: 0,
          updatedAt: Date.now(),
          pads: {
            q: {
              page: "0",
              key: "q",
              name: "Test Sound Q",
              // Minimal valid base64 for a tiny WAV file (silent)
              file: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA",
              filename: "test_q.wav",
              filesize: 100,
              startTime: null,
              endTime: null,
              updatedAt: Date.now(),
              readable: true,
            },
          },
        },
      },
    };
    const impamp2JsonString = JSON.stringify(impamp2ProfileData);
    const impamp2FileName = "impamp2-test-import.json";

    // Find and click profile selector
    const profileSelector = await page.getByRole("button", {
      name: /profile/i,
    });
    await profileSelector.click();

    // Open the manage profiles modal
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    await expect(page.getByText(/Profile Manager/i)).toBeVisible();

    // Switch to Import / Export tab
    await page.getByRole("button", { name: "Import / Export" }).click();
    await expect(
      page.getByRole("heading", { name: "Import Profile" }),
    ).toBeVisible();

    // Locate the hidden file input associated with the "Select File to Import" button
    // The input is likely a sibling or near the button. We target it directly.
    const fileInput = page.locator('[data-testid="import-profile-file-input"]');
    await expect(fileInput).toBeAttached(); // Ensure the input exists

    // Simulate file upload
    await fileInput.setInputFiles({
      name: impamp2FileName,
      mimeType: "application/json",
      buffer: Buffer.from(impamp2JsonString),
    });

    // Wait for success message
    const successMessage = page.locator(".bg-green-50"); // Adjust selector based on actual success message element
    await expect(successMessage).toContainText(
      /Impamp2 profile imported successfully!/i,
    );
    await expect(successMessage).toBeVisible();

    // Switch back to Profiles tab
    // `exact` because "Profiles tab" elsewhere in the modal also matches
    // otherwise — the convention the other specs already follow.
    await page.getByRole("button", { name: "Profiles", exact: true }).click();

    // Verify the new profile exists in the manager list
    const newProfileHeading = page.getByRole("heading", {
      name: /Impamp2 Test Page/i,
    });
    await expect(newProfileHeading).toBeVisible();

    // Close the profile manager
    await page.getByLabel("Close").click();
    await expect(page.getByText(/Profile Manager/i)).toBeHidden();

    // Switch to the newly imported profile
    await profileSelector.click();
    // Use the exact name found in the manager list to select the profile
    const profileName = "Impamp2 Test Page";
    await page.getByRole("menuitem", { name: profileName }).click();

    // Verify the new profile is now active
    const importedProfilebutton = page.getByRole("button", {
      name: profileName,
    });
    await expect(importedProfilebutton).toBeVisible();

    // Verify the imported pad ('q' key maps to index 0) has the correct name
    const firstPad = page.getByRole("button", {
      name: "Sound pad 1: Test Sound Q,",
    });
    await expect(firstPad).toBeVisible();
    await expect(firstPad).toContainText("Test Sound Q");
  });
});
