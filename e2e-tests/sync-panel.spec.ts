import { test, expect, type Page } from "@playwright/test";
import {
  gotoApp,
  openProfileManager,
  readActiveProfile,
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

  test("calls out a synced profile whose sounds reach nobody", async ({
    page,
  }) => {
    // The state that was completely invisible before: server-synced, so it
    // looks shared, but nothing publishes the audio. It is no longer offered
    // as a choice, so the chip's job is to say something is wrong.
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "local",
    });

    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /needs attention/,
    );
    await expect(
      page
        .getByTestId("sync-defect-banner")
        .locator('[data-defect="audio-reaches-nobody"]'),
    ).toContainText(/silent everywhere else/);
    await expect(page.getByTestId("fix-audio-reaches-nobody")).toBeVisible();
  });

  test("does not offer to keep the sounds here on a profile that syncs", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "owner",
      audioLocation: "server",
    });

    await expect(page.getByTestId("audio-location-local")).toHaveCount(0);
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
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
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
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
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
      audioLocation: "server",
    });

    await page.getByTestId("sync-pause").click();
    await page.getByText("For 2 hours").click();

    await expect(page.getByTestId("sync-resume")).toBeVisible();
    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /paused/,
    );
  });
});

/**
 * Moving a profile between sync states.
 *
 * The old UI could only move a profile one way. "Sync to Google Drive"
 * rendered on server-synced profiles too and wrote `syncType` without clearing
 * `serverProfileId`, so the profile stopped syncing to the server while still
 * claiming to live there — and the route back required `syncType === "local"`,
 * which it no longer was. There was no Drive → server path at all.
 */
test.describe("changing where a profile syncs", () => {
  test("the axis is how you turn syncing on", async ({ page }) => {
    await openPanelWith(page, { syncType: "local", audioLocation: "local" });

    // Drive is unavailable while signed out, so its radio is disabled rather
    // than missing — the user can see the option and why they can't take it.
    const drive = page
      .getByTestId("sync-target-googleDrive")
      .getByRole("radio");
    await expect(drive).toBeDisabled();
    await expect(
      page.getByTestId("sync-target-local").getByRole("radio"),
    ).toBeChecked();
  });

  test("a viewer cannot move someone else's profile", async ({ page }) => {
    await openPanelWith(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverShareToken: "tok",
      serverRole: "viewer",
      readOnly: true,
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
    });

    // Publishing someone else's profile under your own account would fork it
    // silently, so every axis is locked rather than merely discouraged.
    await expect(
      page.getByTestId("sync-target-local").getByRole("radio"),
    ).toBeDisabled();
    // A viewer is told why, and offered the only thing that would help.
    await expect(page.getByTestId("follow-explainer")).toContainText(
      /view-only access/i,
    );
    await expect(page.getByTestId("make-own-copy")).toBeVisible();
  });

  test("switching a synced profile back to this device warns first", async ({
    page,
  }) => {
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
    });

    await page.getByTestId("sync-target-local").getByRole("radio").click();

    const modal = page.getByTestId("custom-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/stops updating|left alone/i);

    // Cancelling leaves the profile exactly where it was.
    await page.getByTestId("modal-cancel-button").click();
    await expect(
      page.getByTestId("sync-target-googleDrive").getByRole("radio"),
    ).toBeChecked();
  });

  test("confirming the move applies it and clears the other backend", async ({
    page,
  }) => {
    // The regression test for the one-way trapdoor: after the move, no
    // bookkeeping for the backend it left is still hanging around.
    await openPanelWith(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
    });

    await page.getByTestId("sync-target-local").getByRole("radio").click();
    await page.getByTestId("modal-confirm-button").click();

    await expect(page.getByTestId("sync-status-chip").first()).toHaveText(
      /This device only/,
      { timeout: 15_000 },
    );

    const profile = await readActiveProfile(page);
    expect(profile.syncType).toBe("local");
    expect(profile.googleDriveFileId ?? null).toBeNull();
    expect(profile.googleDriveFolderId ?? null).toBeNull();
    expect(profile.audioLocation).toBe("local");
  });
});
