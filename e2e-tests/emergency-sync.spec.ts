import { test, expect, Page } from "@playwright/test";
import {
  addSoundsToPadModal,
  createTestAudioFilePath,
  enterEditMode,
  exitEditMode,
  getActiveSounds,
  gotoApp,
  openEditPadModal,
  prepareAudioContext,
  savePadEditModal,
} from "./test-helpers";

/**
 * The emergency set is a third cached copy of pad configuration data, next to
 * the pad grid's and the keyboard listener's. It used to be invalidated by its
 * own counter, `emergencySoundsVersion`, which only local edit paths bumped —
 * so a bank changed by a collaborator, by another tab or by another device
 * reached the grid and never reached the Enter key.
 *
 * This spec drives the sync path the way `applySyncedProfile` does: write to
 * IndexedDB, then bump the one version counter, and ask what Enter fires.
 */

const SYNCED_NAME = "Synced Emergency Cue";

/** Nothing may hold focus: a focused pad answers Enter before the window does. */
async function blurEverything(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

async function markFirstBankEmergency(page: Page) {
  await enterEditMode(page);
  await page.locator('[role="tab"]').first().click();
  await page.waitForSelector('[data-testid="custom-modal"]');
  await page.locator('[data-testid="emergency-checkbox"]').check();
  await page.locator('[data-testid="modal-confirm-button"]').click();
  await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
  await exitEditMode(page);
}

/** Press Enter and report the names of whatever it started. */
async function namesPlayedByEnter(page: Page): Promise<string[]> {
  await blurEverything(page);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await getActiveSounds(page)).length, { timeout: 15000 })
    .toBeGreaterThan(0);
  return (await getActiveSounds(page)).map((s) => s.name);
}

async function stopEverything(page: Page) {
  await blurEverything(page);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await getActiveSounds(page)).length).toBe(0);
}

/**
 * Rewrite the emergency pad's name straight into IndexedDB and bump the shared
 * pad-configuration counter — exactly the two steps `applySyncedProfile` takes
 * once a remote change has been written.
 */
async function simulateSyncRenamingPad0(page: Page, newName: string) {
  const profileId = await page.evaluate(() => {
    const store = (
      window as unknown as {
        __profileStore: { getState(): { activeProfileId: number } };
      }
    ).__profileStore;
    return store.getState().activeProfileId;
  });

  await page.evaluate(
    async ({ profileId, newName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("impamp3DB");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const existing = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const req = db
            .transaction("padConfigurations", "readonly")
            .objectStore("padConfigurations")
            .index("profilePagePad")
            .get(IDBKeyRange.only([profileId, 0, 0]));
          req.onsuccess = () => resolve(req.result as Record<string, unknown>);
          req.onerror = () => reject(req.error);
        },
      );
      if (!existing) throw new Error("Pad 0 has no stored configuration");

      await new Promise<void>((resolve, reject) => {
        const req = db
          .transaction("padConfigurations", "readwrite")
          .objectStore("padConfigurations")
          .put({ ...existing, name: newName, updatedAt: new Date() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      db.close();
    },
    { profileId, newName },
  );

  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __profileStore: {
          getState(): { incrementPadConfigsVersion(): void };
        };
      }
    ).__profileStore;
    store.getState().incrementPadConfigsVersion();
  });
}

test.describe("Emergency sounds and sync", () => {
  test("Enter fires the sound a sync just put on the emergency bank", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const filePath = await createTestAudioFilePath("emergency-original", 10);
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [filePath]);
    await savePadEditModal(page);

    await markFirstBankEmergency(page);

    // The emergency set as it stands before any sync.
    const beforeSync = await namesPlayedByEnter(page);
    expect(beforeSync).not.toContain(SYNCED_NAME);
    await stopEverything(page);

    await simulateSyncRenamingPad0(page, SYNCED_NAME);

    // The grid picks the change up — that half was never broken.
    await expect(page.locator('[id^="pad-"]').first()).toContainText(
      SYNCED_NAME,
    );

    // ...and so must Enter. Against the previous commit this still fires the
    // pre-sync cue, because the sync bumped `padConfigsVersion` and the
    // emergency set watched `emergencySoundsVersion`, which nothing in
    // src/lib ever touched.
    expect(await namesPlayedByEnter(page)).toContain(SYNCED_NAME);
  });
});
