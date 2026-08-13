import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gotoApp, openEditPadModal } from "./test-helpers";

/**
 * A pad configuration is allowed to arrive without a playbackType — older
 * exports predate the field, and hand-edited or third-party files may simply
 * omit it. The import then has to pick a default, and it must be the one the
 * app itself uses when it creates a pad, or importing a profile silently
 * changes how those pads play.
 */
test.describe("import defaults", () => {
  test("a pad imported without a playbackType gets the app's default", async ({
    page,
  }) => {
    await gotoApp(page);

    const now = new Date().toISOString();
    // A V2 single-profile export with playbackType deliberately absent from
    // the pad. Two audio ids so the choice of strategy is observable at all.
    const exportData = {
      exportVersion: 2,
      exportDate: now,
      profile: {
        name: "Imported Without PlaybackType",
        syncType: "local",
        backupReminderPeriod: 30,
        createdAt: now,
        updatedAt: now,
      },
      padConfigurations: [
        {
          pageIndex: 0,
          padIndex: 0,
          keyBinding: "q",
          name: "No Playback Type",
          audioFileIds: [1, 2],
          createdAt: now,
          updatedAt: now,
        },
      ],
      pageMetadata: [],
      audioFiles: [
        // A minimal WAV header is enough: nothing here plays the sound, the
        // test only reads back the pad's playback mode.
        {
          id: 1,
          name: "one.wav",
          type: "audio/wav",
          data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
        },
        {
          id: 2,
          name: "two.wav",
          type: "audio/wav",
          data: "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
        },
      ],
    };

    const importPath = path.join(os.tmpdir(), `impamp-no-playbacktype.json`);
    await fs.promises.writeFile(importPath, JSON.stringify(exportData));

    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    await page.getByRole("button", { name: "Import / Export" }).click();
    await page
      .locator('[data-testid="import-profile-file-input"]')
      .setInputFiles(importPath);
    await expect(page.getByText(/imported successfully/i)).toBeVisible();

    // Switch to the imported profile
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await page
      .locator("div")
      .filter({ hasText: /^Imported Without PlaybackType/ })
      .getByRole("button", { name: "Use This Profile" })
      .first()
      .click();
    await page.getByLabel("Close").click();

    // Round-robin is what usePadDrop / usePadInteractions assign to a pad
    // created in the app, so it is what an import must not silently change.
    await openEditPadModal(page, 0);
    await expect(
      page.locator('[data-testid="edit-pad-playback-mode-round-robin"]'),
    ).toBeChecked();

    await fs.promises.unlink(importPath).catch(() => {});
  });
});
