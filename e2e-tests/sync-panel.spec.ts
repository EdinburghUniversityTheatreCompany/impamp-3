import { test, expect, type Page } from "@playwright/test";
import {
  gotoApp,
  openProfileManager,
  seedActiveProfileSync,
  waitForAppReady,
} from "./test-helpers";

/**
 * The profile sync panel: what a profile says about itself.
 *
 * These need no audio, no Google account and no Wasabi bucket. That is
 * deliberate on two counts. The states worth checking are combinations of
 * stored fields, so they can be seeded directly through the store's E2E hook
 * rather than reached by driving a cloud service. And an option that is
 * *unavailable* has to say why rather than disappear — which is exactly the
 * shape an unconfigured test environment produces, so the environment we can
 * actually run in is the one that exercises it.
 */

/** Seed state, reload so the card renders it, and open the panel. */
async function openPanelWith(page: Page, fields: Record<string, unknown>) {
  await gotoApp(page);
  await seedActiveProfileSync(page, fields);
  await page.reload();
  await waitForAppReady(page);

  await openProfileManager(page);
  await page.getByTestId("sync-status-chip").first().click();
  await expect(page.getByTestId("profile-sync-panel").first()).toBeVisible();
}

test.describe("the sync status chip", () => {
  test("a fresh profile says it stays on this device", async ({ page }) => {
    await gotoApp(page);
    await openProfileManager(page);

    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /This device only/,
    );
  });

  test("a server profile with no Drive folder admits its sounds go nowhere", async ({
    page,
  }) => {
    // The state that was completely invisible before: server-synced, so it
    // looks shared, but nothing publishes the audio.
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "local",
    });

    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /ImpAmp server.*sounds stay on this device/,
    );
  });

  test("a profile needing attention says so rather than a sync time", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: null,
    });

    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /needs attention/,
    );
  });
});

test.describe("the two axes", () => {
  test("both questions are asked, and the current answers marked", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
    });

    await expect(page.getByText("Profile syncs to")).toBeVisible();
    await expect(page.getByText("Sounds are stored in")).toBeVisible();

    await expect(page.getByTestId("sync-target-server")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(
      page.getByTestId("audio-location-googleDrive"),
    ).toHaveAttribute("data-selected", "true");
  });

  test("a local profile is not asked where its sounds go", async ({ page }) => {
    // With nowhere to sync there is nobody to publish to, so the question has
    // one answer and asking it would be noise.
    await openPanelWith(page, { syncType: "local", audioLocation: "local" });

    await expect(page.getByText("Profile syncs to")).toBeVisible();
    await expect(page.getByText("Sounds are stored in")).toHaveCount(0);
  });

  test("an option we cannot offer says why instead of vanishing", async ({
    page,
  }) => {
    // Signed out of Google, so Drive sync is unavailable — and has to be
    // visible and explained rather than absent, which is what hid server sync
    // from everyone who had never signed in.
    await openPanelWith(page, { syncType: "local", audioLocation: "local" });

    const driveOption = page.getByTestId("sync-target-googleDrive");
    await expect(driveOption).toBeVisible();
    await expect(driveOption).toContainText(/Sign in with Google/);
  });

  test("hosted audio is offered only where the server actually hosts it", async ({
    page,
  }) => {
    // The E2E server sets no IMPAMP_S3_* variables, so hosting is genuinely
    // off — every audio route answers 501 (see server-sync.spec.ts).
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "local",
    });

    const hosted = page.getByTestId("audio-location-server");
    await expect(hosted).toBeVisible();
    await expect(hosted).toContainText(/Sign in|does not host/);
  });
});

test.describe("defects", () => {
  test("a Drive profile with no file explains what is wrong", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: null,
    });

    const banner = page.getByTestId("sync-defect-banner");
    await expect(banner).toBeVisible();
    await expect(
      banner.locator('[data-defect="drive-linked-but-no-file"]'),
    ).toContainText(/no file in Drive/);
  });

  test("server bookkeeping left on a Drive profile is called out", async ({
    page,
  }) => {
    // What pressing "Sync to Google Drive" on a server profile leaves behind.
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      serverProfileId: "srv-1",
    });

    await expect(
      page
        .getByTestId("sync-defect-banner")
        .locator('[data-defect="stale-server-link"]'),
    ).toBeVisible();
  });

  test("a healthy profile shows no banner", async ({ page }) => {
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
    });

    await expect(page.getByTestId("sync-defect-banner")).toHaveCount(0);
  });
});

test.describe("controls", () => {
  test("a server profile gets the same controls Drive has", async ({
    page,
  }) => {
    // Server sync had none of these. Not because it could not be paused —
    // the sync loop has always honoured syncPausedUntil — but because the
    // controls lived inside a block gated on having a Drive file.
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "local",
    });

    await expect(page.getByTestId("sync-now")).toBeVisible();
    await expect(page.getByTestId("sync-pause")).toBeVisible();
  });

  test("a local profile gets no sync controls at all", async ({ page }) => {
    await openPanelWith(page, { syncType: "local", audioLocation: "local" });

    await expect(page.getByTestId("sync-controls")).toHaveCount(0);
  });

  test("pausing offers durations and then reports the pause", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "local",
    });

    await page.getByTestId("sync-pause").click();
    await page.getByText("For 2 hours").click();

    await expect(page.getByTestId("sync-resume")).toBeVisible();
    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /paused/,
    );
  });
});
