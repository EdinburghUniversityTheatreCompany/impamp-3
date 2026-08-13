import { test, expect } from "@playwright/test";
import {
  prepareAudioContext,
  createTestAudioFilePath,
  createMultipleTestAudioFiles,
  // Import the moved helpers
  openEditPadModal,
  addSoundsToPadModal,
  setPlaybackModeInModal,
  removeSoundFromModal,
  savePadEditModal,
  createNewBankViaUi,
  gotoApp,
  enterEditMode,
  exitEditMode,
} from "./test-helpers";

// Helper definitions moved to test-helpers.ts

test.describe("ImpAmp3 Edit Mode", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);

    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test("Shift key activates and deactivates edit mode", async ({ page }) => {
    // Assert on the banner itself rather than a textContent("body") snapshot
    // taken after a fixed wait: the snapshot is a single read with no
    // retrying, so it captures whatever the page happened to look like at that
    // instant and fails whenever edit mode is a few milliseconds late.
    const editModeBanner = page.getByText("EDIT MODE", { exact: true });

    await expect(editModeBanner).toBeHidden();

    await page.keyboard.down("Shift");
    await expect(editModeBanner).toBeVisible();

    await page.keyboard.up("Shift");
    await expect(editModeBanner).toBeHidden();
  });

  test("Can rename pads in edit mode", async ({ page }) => {
    // Enter edit mode
    await enterEditMode(page);

    // Verify edit mode is active
    await expect(page.getByText("EDIT MODE", { exact: true })).toBeVisible();

    // Get the first pad
    const firstPad = page.locator('[id^="pad-"]').first();

    // Store the original pad text (ensure it's not null)
    const originalText = (await firstPad.textContent()) ?? "";

    // Click the pad to trigger rename (Shift is already down)
    // Click the pad to trigger the EDIT modal (Shift is already down)
    await firstPad.click();

    // Wait for the EDIT modal to appear
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText(
      "Edit Pad",
    ); // Expect Edit Pad modal now

    // Fill the name input in the EDIT modal and confirm
    const inputField = page.locator('[data-testid="edit-pad-name-input"]'); // Use the correct test ID
    await inputField.fill("Custom Pad Name");
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key (or ensure it's released if test requires it)
    // Note: The modal logic itself handles releasing edit mode if shift is up *after* confirm/cancel
    // We might not need to explicitly release shift here if the modal handles it. Let's keep it for now.
    await exitEditMode(page);

    // Verify the pad name was updated
    await expect(firstPad).toContainText("Custom Pad Name");
    expect(await firstPad.textContent()).not.toBe(originalText);
  });

  test("Can create new banks and rename them", async ({ page }) => {
    // --- Create the new bank ---
    const initialBanks = await createNewBankViaUi(page);

    const newBankTab = page.locator('[role="tab"]').last(); // Get the newly added tab
    await expect(newBankTab).toContainText(`Bank ${initialBanks + 1}`);

    // --- Rename the new bank ---
    // Ensure Shift is still down (or press it again if needed)
    await enterEditMode(page);

    // Click the new bank tab to trigger edit modal
    await newBankTab.click();

    // Wait for the 'Edit Bank' modal
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText(
      `Edit Bank ${initialBanks + 1}`,
    );

    // Fill the name input
    const nameInput = page.locator('[data-testid="bank-name-input"]');
    await nameInput.fill("Custom Bank");

    // Ensure emergency checkbox is not checked (it shouldn't be by default)
    const emergencyCheckbox = page.locator(
      '[data-testid="emergency-checkbox"]',
    );
    await expect(emergencyCheckbox).not.toBeChecked();

    // Click confirm
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key
    await exitEditMode(page);

    // Verify the bank name was updated on the tab
    await expect(newBankTab).toContainText(`Custom Bank`);
    // Also check the title attribute for the full name
    await expect(newBankTab).toHaveAttribute("title", "Custom Bank");
  });

  test("Can mark a bank as emergency", async ({ page }) => {
    // Enter edit mode
    await enterEditMode(page);

    // Find the first bank tab
    const firstBankTab = page.locator('[role="tab"]').first();
    // const initialBankName = await firstBankTab.textContent() ?? ''; // Removed unused variable

    // Verify emergency indicator is initially hidden
    const emergencyIndicatorSelector =
      "span.ml-2.w-3.h-3.bg-red-500.rounded-full";
    await expect(firstBankTab.locator(emergencyIndicatorSelector)).toBeHidden();

    // Click the first bank tab to open the edit modal
    await firstBankTab.click();

    // Wait for the 'Edit Bank' modal
    await page.waitForSelector('[data-testid="custom-modal"]');
    await expect(page.locator('[data-testid="modal-title"]')).toContainText(
      "Edit Bank 1",
    ); // Assuming first bank is Bank 1

    // Check the emergency checkbox
    const emergencyCheckbox = page.locator(
      '[data-testid="emergency-checkbox"]',
    );
    await emergencyCheckbox.check();

    // Click confirm
    await page.locator('[data-testid="modal-confirm-button"]').click();

    // Wait for modal to disappear
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();

    // Release shift key
    await exitEditMode(page);

    // Verify the emergency indicator is now visible on the first bank tab
    // Re-locate the tab
    const updatedFirstBankTab = page.locator('[role="tab"]').first();
    await expect(
      updatedFirstBankTab.locator(emergencyIndicatorSelector),
    ).toBeVisible();
    // Verify title attribute also indicates emergency
    await expect(updatedFirstBankTab).toHaveAttribute(
      "title",
      expect.stringContaining("(Emergency)"),
    );
  });

  // --- Tests for Multi-Sound Pad Editing ---

  test("opens edit modal on Shift+click (empty pad)", async ({ page }) => {
    await openEditPadModal(page, 0); // Open modal for first pad
    // Verify some elements inside the modal to confirm it's the right one
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="edit-pad-sounds-list"]'),
    ).not.toBeVisible(); // List shouldn't exist if empty
    await expect(page.getByText("No sounds assigned.")).toBeVisible();
    await expect(
      page.locator('[data-testid="edit-pad-add-sounds-button"]'),
    ).toBeVisible();
  });

  test("opens edit modal on Shift+click (single sound pad)", async ({
    page,
  }) => {
    const fileName = "single-sound-edit";
    const filePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-1"]'); // Use second pad
    await padInput.setInputFiles(filePath);
    await expect(page.locator('[id^="pad-"][id$="-1"]')).toContainText(
      fileName,
      { timeout: 5000 },
    );

    await openEditPadModal(page, 1); // Open modal for second pad

    // Verify elements, including the single sound in the list
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toHaveValue(fileName);
    await expect(
      page.locator('[data-testid="edit-pad-sounds-list"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        `[data-testid^="edit-pad-sound-item-"]:has-text("${fileName}")`,
      ),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(1); // Ensure only one item
  });

  test("adds multiple sounds via modal", async ({ page }) => {
    const fileNames = ["soundA", "soundB"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    await openEditPadModal(page, 2); // Use third pad
    await addSoundsToPadModal(page, filePaths);

    // Verify sounds appear in the modal list
    await expect(
      page.locator(
        `[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[0]}")`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(
        `[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`,
      ),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(2);

    await savePadEditModal(page);

    // Verify pad is configured (check name updated to first sound)
    const pad = page.locator('[id^="pad-"][id$="-2"]');
    await expect(pad).toContainText(fileNames[0]); // Name should update
  });

  test("updates pad name correctly when adding first sounds", async ({
    page,
  }) => {
    const fileNames = ["firstSoundName"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    await openEditPadModal(page, 3); // Use fourth pad
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toHaveValue("Empty Pad"); // Verify initial state

    await addSoundsToPadModal(page, filePaths);
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toHaveValue(fileNames[0]); // Verify name updated in modal

    await savePadEditModal(page);

    // Verify pad name is updated on the grid
    const pad = page.locator('[id^="pad-"][id$="-3"]');
    await expect(pad).toContainText(fileNames[0]);
  });

  test("preserves existing pad name when adding more sounds", async ({
    page,
  }) => {
    const initialName = "initial-sound";
    const customName = "My Custom Pad";
    const additionalSound = "additional-sound";
    const initialFilePath = await createTestAudioFilePath(initialName);
    const additionalFilePath = await createTestAudioFilePath(additionalSound);

    // Configure pad 4 with one sound
    const padInput = page.locator('[data-testid="pad-drop-input-4"]');
    await padInput.setInputFiles(initialFilePath);
    await expect(page.locator('[id^="pad-"][id$="-4"]')).toContainText(
      initialName,
      { timeout: 5000 },
    );

    // Rename it
    await page.keyboard.down("Shift");
    await page.locator('[id^="pad-"][id$="-4"]').click();
    await page.waitForSelector('[data-testid="custom-modal"]'); // Shift+click opens the Edit Pad modal
    await page.locator('[data-testid="edit-pad-name-input"]').fill(customName);
    await page.locator('[data-testid="modal-confirm-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
    await expect(page.locator('[id^="pad-"][id$="-4"]')).toContainText(
      customName,
    );
    await page.keyboard.up("Shift"); // Release shift after rename

    // Open edit modal again
    await openEditPadModal(page, 4);
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toHaveValue(customName); // Verify custom name loaded

    // Add another sound
    await addSoundsToPadModal(page, [additionalFilePath]);
    await expect(
      page.locator('[data-testid="edit-pad-name-input"]'),
    ).toHaveValue(customName); // Verify name NOT changed

    await savePadEditModal(page);

    // Verify pad name is still the custom name
    const pad = page.locator('[id^="pad-"][id$="-4"]');
    await expect(pad).toContainText(customName);
  });

  test("removes a sound via modal", async ({ page }) => {
    const fileNames = ["soundToRemove", "soundToKeep"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add two sounds via modal
    await openEditPadModal(page, 5); // Use pad 5
    await addSoundsToPadModal(page, filePaths);
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(2);

    // Remove the first sound
    await removeSoundFromModal(page, fileNames[0]);
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(1);
    await expect(
      page.locator(
        `[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`,
      ),
    ).toBeVisible();

    await savePadEditModal(page);

    // Re-open modal to verify persistence (or use playback test)
    await openEditPadModal(page, 5);
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(1);
    await expect(
      page.locator(
        `[data-testid^="edit-pad-sound-item-"]:has-text("${fileNames[1]}")`,
      ),
    ).toBeVisible();
  });

  test("changes playback mode via modal", async ({ page }) => {
    const fileNames = ["modeTestA", "modeTestB"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add sounds
    await openEditPadModal(page, 6); // Use pad 6
    await addSoundsToPadModal(page, filePaths);

    // Check default mode (should be round-robin now)
    await expect(
      page.locator('[data-testid="edit-pad-playback-mode-round-robin"]'),
    ).toBeChecked();

    // Change to sequential
    await setPlaybackModeInModal(page, "sequential");
    await expect(
      page.locator('[data-testid="edit-pad-playback-mode-sequential"]'),
    ).toBeChecked();

    await savePadEditModal(page);

    // Re-open and verify mode persisted
    await openEditPadModal(page, 6);
    await expect(
      page.locator('[data-testid="edit-pad-playback-mode-sequential"]'),
    ).toBeChecked();
  });

  test("Delete/Move mode click opens the edit modal for a multi-sound pad", async ({
    page,
  }) => {
    const fileNames = ["multiSoundX1", "multiSoundX2"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add two sounds via modal to pad 7
    await openEditPadModal(page, 7);
    await addSoundsToPadModal(page, filePaths);
    await savePadEditModal(page);

    // Removing a sound is no longer an "X" button on the pad in edit mode:
    // it is a click on the pad in Delete/Move mode, toggled from the toolbar.
    await page
      .getByRole("button", { name: "Toggle delete and move mode" })
      .click();

    const pad = page.locator('[id^="pad-"][id$="-7"]');
    await pad.click();

    // A pad holding more than one sound can't guess which sound to drop, so
    // it opens the edit modal rather than a "Remove Sound" confirmation.
    await expect(page.locator('[data-testid="custom-modal"]')).toBeVisible();
    await expect(page.locator('[data-testid="modal-title"]')).toContainText(
      "Edit Pad",
    );
    await expect(
      page.locator('[data-testid="edit-pad-sounds-list"]'),
    ).toBeVisible();
    // Both sounds are offered for individual removal
    await expect(
      page.locator('[data-testid^="edit-pad-sound-item-"]'),
    ).toHaveCount(2);

    await page.locator('[data-testid="modal-cancel-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
  });
});
