import { test, expect, type Page } from "@playwright/test";
import { readFile } from "fs/promises";
import {
  createTestAudioFilePath,
  gotoApp,
  openProfileManager,
  readActiveProfile,
  seedActiveProfileSync,
  waitForAppReady,
} from "./test-helpers";

/**
 * Following a profile: receive changes, send none, and do not edit it.
 *
 * The old "Read-only" checkbox stored its answer in `readOnly`, which the
 * Drive sync reconciles against the folder's real permissions on every run —
 * so ticking it on a folder you could write to was undone by the first sync.
 * It only stuck where it changed nothing.
 *
 * And read-only never blocked editing at all. A viewer could rearrange
 * someone's board and lose the work silently, because the next sync applies
 * the merged remote state over it.
 */

async function openSyncPanel(page: Page) {
  await openProfileManager(page);
  await page.getByTestId("sync-status-chip").first().click();
  await expect(page.getByTestId("profile-sync-panel").first()).toBeVisible();
}

/** Shift is what opens edit mode, so it is what the test presses. */
async function tryToEnterEditMode(page: Page) {
  await page.keyboard.down("Shift");
  await page.waitForTimeout(300);
}

test.describe("following a profile", () => {
  test("survives a sync that finds you can write", async ({ page }) => {
    // The whole point: the Drive reconciler sets readOnly=false whenever the
    // folder says owner/writer. A follow stored there would be wiped.
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      googleDriveFolderId: "folder-1",
      audioLocation: "googleDrive",
      followOnly: true,
      readOnly: false,
    });
    await page.reload();
    await waitForAppReady(page);

    const profile = await readActiveProfile(page);
    expect(profile.followOnly).toBe(true);
    // Stored apart from readOnly, which is the remote's answer, not ours.
    expect(profile.readOnly ?? false).toBe(false);
  });

  test("refuses edit mode, and says why", async ({ page }) => {
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);

    await expect(page.getByTestId("read-only-banner")).toContainText(
      /following this profile/i,
    );

    await tryToEnterEditMode(page);
    await expect(page.getByText("EDIT MODE", { exact: true })).toHaveCount(0);
    await page.keyboard.up("Shift");
  });

  test("refuses edit mode for a viewer, who never chose anything", async ({
    page,
  }) => {
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "viewer",
      readOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);

    await expect(page.getByTestId("read-only-banner")).toContainText(
      /view-only access/i,
    );

    await tryToEnterEditMode(page);
    await expect(page.getByText("EDIT MODE", { exact: true })).toHaveCount(0);
    await page.keyboard.up("Shift");
  });

  test("a latched edit mode does not survive switching to a followed profile", async ({
    page,
  }) => {
    // Refusing to *enter* the mode is not enough on its own: a mode already
    // on would otherwise stay on across the switch, leaving the pads editable
    // on a profile whose next sync overwrites the work.
    await gotoApp(page);
    await page.evaluate(() => {
      (
        window as unknown as {
          __profileStore: { getState(): { setEditMode(on: boolean): void } };
        }
      ).__profileStore
        .getState()
        .setEditMode(true);
    });
    await expect(page.getByText("EDIT MODE", { exact: true })).toBeVisible();

    await seedActiveProfileSync(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __profileStore: {
            getState(): {
              activeProfileId: number | null;
              setActiveProfileId(id: number): void;
            };
          };
        }
      ).__profileStore;
      store.getState().setActiveProfileId(store.getState().activeProfileId!);
    });

    await expect(page.getByText("EDIT MODE", { exact: true })).toHaveCount(0);
  });

  test("refuses a dropped sound, which needs no edit mode to land", async ({
    page,
  }) => {
    // The Shift gates cover the edit modal, the delete/move mode and the
    // banner. They do not cover this: dropping a file onto a pad writes a pad
    // configuration in normal mode, with nothing switched on. On a followed
    // profile the sound would be added and then destroyed by the next sync
    // applying the remote state over it.
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);

    const name = "RefusedDrop";
    const wavPath = await createTestAudioFilePath(name, 1);
    const wavBase64 = (await readFile(wavPath)).toString("base64");
    const pad = page.locator('[id^="pad-"]').first();

    const dataTransfer = await page.evaluateHandle(
      ([fileName, b64]) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], fileName, { type: "audio/wav" }));
        return dt;
      },
      [`${name}.wav`, wavBase64],
    );

    await pad.dispatchEvent("dragenter", { dataTransfer });
    await pad.dispatchEvent("drop", { dataTransfer });

    // The same drop on an editable profile lands within a second or two
    // (see audio-playback.spec.ts), so an empty pad here is a refusal rather
    // than a race.
    await page.waitForTimeout(2_000);
    await expect(pad).not.toContainText(name);
  });

  test("lets you edit again once you stop following", async ({ page }) => {
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "googleDrive",
      googleDriveFileId: "file-1",
      followOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);
    await openSyncPanel(page);

    await page.getByTestId("unfollow").click();
    await expect(page.getByTestId("read-only-banner")).toHaveCount(0);

    expect((await readActiveProfile(page)).followOnly).toBe(false);
  });

  test("offers no unfollow where the remote refuses writes anyway", async ({
    page,
  }) => {
    // Dropping the follow would promise writes the server will not accept.
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "viewer",
      readOnly: true,
      followOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);
    await openSyncPanel(page);

    await expect(page.getByTestId("unfollow")).toHaveCount(0);
    await expect(page.getByTestId("make-own-copy")).toBeVisible();
  });

  test("a copy of a board you cannot edit is yours, local, and editable", async ({
    page,
  }) => {
    await gotoApp(page);
    await seedActiveProfileSync(page, {
      syncType: "server",
      serverProfileId: "srv-1",
      serverRole: "viewer",
      readOnly: true,
    });
    await page.reload();
    await waitForAppReady(page);
    await openSyncPanel(page);

    await page.getByTestId("make-own-copy").click();

    // The copy becomes the active profile, and is local and unlinked: it is
    // yours now, and connecting it anywhere is a separate decision.
    await expect
      .poll(async () => (await readActiveProfile(page)).syncType, {
        timeout: 15_000,
      })
      .toBe("local");

    const copy = await readActiveProfile(page);
    expect(String(copy.name)).toMatch(/my copy/);
    expect(copy.serverProfileId ?? null).toBeNull();
    expect(copy.followOnly ?? false).toBe(false);

    // And it can actually be edited, which is the entire point of copying it.
    await expect(page.getByTestId("read-only-banner")).toHaveCount(0);
  });
});
