import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createTestAudioFilePath,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
} from "./test-helpers";

test.describe("Profile export/import round-trip", () => {
  test.beforeEach(async ({ page }) => {
    // Force the in-memory blob download fallback: the File System Access API
    // save dialog (used in Chromium) is a native dialog that cannot be driven
    // from Playwright, while the fallback surfaces as a normal download event.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });

    await page.goto("/");
    await page.waitForSelector('[id^="pad-"]');
  });

  test("exports a profile as .iaz and imports it back", async ({ page }) => {
    // Assign a sound to pad 0 so the export contains audio data
    const audioPath = await createTestAudioFilePath("roundtrip-sound");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [audioPath]);
    await savePadEditModal(page);

    // Open Profile Manager → Import / Export tab
    await page.getByRole("button", { name: /profile/i }).click();
    await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Import / Export" }).click();

    // Select the default profile for export
    const exportSection = page.locator("section", {
      hasText: "Export Profiles",
    });
    await exportSection.getByRole("checkbox").first().check();

    // Export and capture the resulting download
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Export Selected/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.iaz$/);

    const exportedPath = path.join(
      os.tmpdir(),
      `impamp-roundtrip-${Date.now()}.iaz`,
    );
    await download.saveAs(exportedPath);

    // Sanity check: the archive contains audio data, not just metadata
    const stat = await fs.promises.stat(exportedPath);
    expect(stat.size).toBeGreaterThan(10_000);

    // Import the exported file back
    await page
      .locator('[data-testid="import-profile-file-input"]')
      .setInputFiles(exportedPath);
    await expect(page.getByText(/imported successfully/i)).toBeVisible({
      timeout: 30_000,
    });

    // The imported copy gets a de-duplicated name and appears in the list
    await page.getByRole("button", { name: "Profiles", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Default Local Profile (1)" }),
    ).toBeVisible();

    await fs.promises.unlink(exportedPath).catch(() => {});
  });
});
