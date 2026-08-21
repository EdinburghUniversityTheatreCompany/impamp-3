import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  activatePad,
  addSoundsToPadModal,
  createTestAudioFilePath,
  gotoApp,
  openEditPadModal,
  savePadEditModal,
} from "./test-helpers";

/**
 * The store's two bank-archive actions, in a browser.
 *
 * The unit suite (`src/store/profileStore.bankTransfer.test.ts`) can see every
 * argument these actions pass and the counter they bump, and it cannot see the
 * one thing that matters most: whether the board notices. The import writes
 * banks and pads straight into IndexedDB, and every copy the app has of that
 * data is in memory — the bank tabs, the pad grid, the keyboard listener's
 * map. They are all refreshed off `padConfigsVersion`, and dropping that one
 * line leaves the whole unit suite green while the imported bank never appears
 * at all. That is the mutation this file exists to kill, and it is the same
 * shape the duplicate-audio panel hit one task ago: green in jsdom, silent in
 * a browser, for the rest of the session.
 *
 * There is no import UI yet — Tasks 14 and 15 add it — so the actions are
 * driven through `window.__profileStore`, the read/write hook the sync specs
 * already use. Everything asserted afterwards is what a user would see.
 */

interface BankStoreHook {
  getState(): {
    activeProfileId: number | null;
    banks: Array<{ bankId: string; name: string }>;
    exportBanksToZip(
      profileId: number,
      bankIds: string[],
      bankNames: string[],
    ): Promise<boolean>;
    importBanksFromArchive(
      file: Blob,
      profileId: number,
      placements: Record<string, { kind: string; bankId?: string }>,
    ): Promise<{ written: { name: string }[]; skipped: string[] }>;
  };
}

test.describe("Bank export and import through the store", () => {
  test.beforeEach(async ({ page }) => {
    // Force the in-memory blob download fallback: the File System Access API
    // save dialog is native and cannot be driven from Playwright, while the
    // fallback surfaces as an ordinary download event.
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });

    await gotoApp(page);
  });

  test("an imported bank arrives on the board, tab and pad, with no reload", async ({
    page,
  }) => {
    const audioPath = await createTestAudioFilePath("bank-transfer-sound");
    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [audioPath]);
    await savePadEditModal(page);

    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(10);
    // The imported copy carries the source bank's NAME, so "Bank 1" appearing
    // twice is the tell. A bank added through the UI would be "Bank 11".
    await expect(tabs.nth(0)).toHaveText("1: Bank 1");

    const downloadPromise = page.waitForEvent("download");
    const exported = await page.evaluate(async () => {
      const store = (window as unknown as { __profileStore: BankStoreHook })
        .__profileStore;
      const { activeProfileId, banks, exportBanksToZip } = store.getState();
      return exportBanksToZip(
        activeProfileId!,
        [banks[0].bankId],
        [banks[0].name],
      );
    });
    expect(exported).toBe(true);

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      `impamp-bank-bank-1-${new Date().toISOString().split("T")[0]}.iaz`,
    );
    const archivePath = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "impamp-bank-")),
      "banks.iaz",
    );
    await download.saveAs(archivePath);
    // The sound is in there, not just the metadata.
    expect((await fs.promises.stat(archivePath)).size).toBeGreaterThan(10_000);

    const archiveBase64 = (await fs.promises.readFile(archivePath)).toString(
      "base64",
    );
    const written = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const store = (window as unknown as { __profileStore: BankStoreHook })
        .__profileStore;
      const { activeProfileId, importBanksFromArchive } = store.getState();
      const result = await importBanksFromArchive(
        new Blob([bytes]),
        activeProfileId!,
        { "0": { kind: "add" } },
      );
      return result.written.map((bank) => bank.name);
    }, archiveBase64);
    expect(written).toEqual(["Bank 1"]);

    // Nothing below reloads the page. The tab strip renders from
    // `profileStore.banks`, which `app/page.tsx` refills when
    // `padConfigsVersion` moves — so an eleventh tab appearing here is the
    // whole of "the board was told".
    await expect(tabs).toHaveCount(11);
    await expect(tabs.nth(10)).toHaveText("11: Bank 1");

    await tabs.nth(10).click();
    const pad = page.locator('[id^="pad-"]').first();
    await expect(pad).toContainText("bank-transfer-sound");
    // And the sound itself came with it: the pad's audio row was written into
    // this device's library, not merely referenced by id.
    await activatePad(page, pad);

    await fs.promises.rm(path.dirname(archivePath), {
      recursive: true,
      force: true,
    });
  });
});
