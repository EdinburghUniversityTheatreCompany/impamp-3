import { test, expect } from '@playwright/test';

test.describe('Sync Refresh', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait until a real profile is active in the store (not null)
    await page.waitForFunction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__profileStore;
      return store && store.getState().activeProfileId !== null;
    });
  });

  test('Pad grid updates immediately when sync writes new data, without switching banks', async ({ page }) => {
    // Get the active profile ID
    const activeProfileId = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__profileStore;
      if (!store) throw new Error('__profileStore not exposed on window');
      return store.getState().activeProfileId as number;
    });

    // Directly write a pad config to IndexedDB — this simulates what Google Drive sync does
    await page.evaluate(async (profileId: number) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('impamp3DB');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (!profileId || typeof profileId !== 'number') throw new Error(`Invalid profileId: ${profileId}`);

      // Upsert: look up existing record by index, preserve its id if found
      const existing = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const tx = db.transaction('padConfigurations', 'readonly');
        const req = tx.objectStore('padConfigurations').index('profilePagePad').get(IDBKeyRange.only([profileId, 0, 0]));
        req.onsuccess = () => resolve(req.result as Record<string, unknown> | undefined);
        req.onerror = () => reject(req.error);
      });

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('padConfigurations', 'readwrite');
        const record: Record<string, unknown> = {
          ...(existing ?? {}),
          profileId,
          pageIndex: 0,
          padIndex: 0,
          name: 'Synced Name',
          audioFileIds: existing?.audioFileIds ?? [],
          playbackType: existing?.playbackType ?? 'sequential',
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        // Only include 'id' if updating an existing record (autoIncrement handles new ones)
        if (existing?.id !== undefined) record.id = existing.id;
        const req = tx.objectStore('padConfigurations').put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      db.close();
    }, activeProfileId);

    // Trigger the pad refresh — this is what sync should call after updating IndexedDB
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__profileStore;
      store.getState().incrementPadConfigsVersion();
    });

    // The pad grid should update without any bank switch
    const firstPad = page.locator('[id^="pad-"]').first();
    await expect(firstPad).toContainText('Synced Name');
  });
});
