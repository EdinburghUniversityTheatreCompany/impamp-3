import { test, expect, type Page } from "@playwright/test";
import { gotoApp, waitForAppReady } from "./test-helpers";

/**
 * Opening a server share link used to copy the *owner's* Google Drive ids into
 * the recipient's profile. The import no longer does that, but profiles
 * created before the fix still hold them — and they are not inert: server sync
 * reads `googleDriveFolderId` and tries to upload audio into it, which for a
 * collaborator means writing into a folder they do not own. Those failures are
 * swallowed per file, so it fails quietly.
 *
 * A one-off sweep clears them on load. These tests drive it through the real
 * app: seed the state, clear the "already swept" flag, reload, read the
 * profile back out of the store.
 *
 * No audio and no Google account required, which also keeps them off the two
 * things that make cross-browser runs unreliable.
 */

const SWEEP_KEY = "impamp.reconciledBorrowedDriveLinks.v1";

type ProfileFields = Record<string, unknown>;

/** Write sync bookkeeping straight onto the active profile. */
async function seedActiveProfile(page: Page, fields: ProfileFields) {
  await page.evaluate(async (patch) => {
    const store = (
      window as unknown as {
        __profileStore: {
          getState(): {
            activeProfileId: number | null;
            updateProfile(id: number, updates: unknown): Promise<void>;
          };
        };
      }
    ).__profileStore;
    const { activeProfileId, updateProfile } = store.getState();
    await updateProfile(activeProfileId!, patch);
  }, fields);
}

/** Read the active profile back, after letting the store refresh. */
async function readActiveProfile(page: Page): Promise<ProfileFields> {
  return page.evaluate(async () => {
    const store = (
      window as unknown as {
        __profileStore: {
          getState(): {
            activeProfileId: number | null;
            fetchProfiles(): Promise<unknown>;
            profiles: Array<{ id?: number } & Record<string, unknown>>;
          };
        };
      }
    ).__profileStore;
    await store.getState().fetchProfiles();
    const { activeProfileId, profiles } = store.getState();
    return profiles.find((p) => p.id === activeProfileId) as Record<
      string,
      unknown
    >;
  });
}

/** Re-run the sweep by forgetting that it already ran, then reloading. */
async function reloadWithSweepArmed(page: Page) {
  await page.evaluate((key) => localStorage.removeItem(key), SWEEP_KEY);
  await page.reload();
  await waitForAppReady(page);
}

test.describe("borrowed Drive links", () => {
  test("a profile opened from a share link loses the owner's Drive ids", async ({
    page,
  }) => {
    await gotoApp(page);

    await seedActiveProfile(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverShareToken: "share-token",
      googleDriveFileId: "their-file",
      googleDriveFolderId: "their-folder",
    });

    await reloadWithSweepArmed(page);

    const profile = await readActiveProfile(page);
    expect(profile.googleDriveFileId ?? null).toBeNull();
    expect(profile.googleDriveFolderId ?? null).toBeNull();

    // Only the Drive ids go. The profile is still the shared one, and still
    // syncs — the sounds arrive by download rather than from the folder.
    expect(profile.syncType).toBe("server");
    expect(profile.serverProfileId).toBe("srv-1");
    expect(profile.serverShareToken).toBe("share-token");
  });

  test("an owner's own Drive folder is left alone", async ({ page }) => {
    await gotoApp(page);

    await seedActiveProfile(page, {
      syncType: "server",
      serverProfileId: "srv-2",
      serverRole: "owner",
      googleDriveFolderId: "my-folder",
    });

    await reloadWithSweepArmed(page);

    const profile = await readActiveProfile(page);
    expect(profile.googleDriveFolderId).toBe("my-folder");
  });

  test("a plain Drive profile is left alone", async ({ page }) => {
    await gotoApp(page);

    await seedActiveProfile(page, {
      syncType: "googleDrive",
      googleDriveFileId: "my-file",
      googleDriveFolderId: "my-folder",
    });

    await reloadWithSweepArmed(page);

    const profile = await readActiveProfile(page);
    expect(profile.googleDriveFileId).toBe("my-file");
    expect(profile.googleDriveFolderId).toBe("my-folder");
  });

  test("the sweep does not run twice", async ({ page }) => {
    await gotoApp(page);

    // First load already swept, so the flag is set and a profile seeded now
    // survives an ordinary reload.
    await seedActiveProfile(page, {
      syncType: "server",
      serverProfileId: "srv-3",
      serverShareToken: "share-token",
      googleDriveFolderId: "their-folder",
    });

    await page.reload();
    await waitForAppReady(page);

    const profile = await readActiveProfile(page);
    expect(profile.googleDriveFolderId).toBe("their-folder");
  });
});
