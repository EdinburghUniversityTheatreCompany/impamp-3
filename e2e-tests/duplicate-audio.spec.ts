import { test, expect, type Page } from "@playwright/test";
import {
  activatePad,
  addSoundsToPadModal,
  countAudioFiles,
  createTestAudioFilePath,
  gotoApp,
  openEditPadModal,
  openProfileManager,
  savePadEditModal,
} from "./test-helpers";

/**
 * The Maintenance tab's duplicate-audio panel, in a real browser.
 *
 * A jsdom test of this panel proves the component's half and nothing about the
 * app: whether the section is reachable from the Profile Manager, whether the
 * browser's own confirmation dialog is what stands in front of the deletion,
 * and — the one that matters — whether a pad whose sound was just re-pointed
 * at a different row still plays. That last one is the whole reason the panel
 * bumps `padConfigsVersion`: the board, the keyboard listener and the search
 * index each hold a copy of the pad configurations read at some earlier
 * moment, and every one of those copies names an id that no longer exists.
 *
 * Making the duplicates is the awkward part, because the import paths no
 * longer produce any: `addOrReuseAudioFile` points the second import at the
 * row the first one wrote. So the fixture assigns two genuinely different
 * sounds and then overwrites one row's bytes with the other's, which is the
 * shape a library upgraded from an older release is already in.
 */

/**
 * Copies the lowest-id row's bytes and hash over every other row.
 *
 * The loudness analysis goes with the old bytes rather than travelling with
 * them: leaving a stale one on the row would let it win the election, and the
 * point of the fixture is that the *other* pad — the one that has to be
 * re-pointed and then still play — is the one holding the doomed copy.
 */
async function makeEveryRowTheSameSound(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open("impamp3DB");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const store = db
            .transaction("audioFiles", "readwrite")
            .objectStore("audioFiles");
          const all = store.getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const rows = [...all.result].sort((a, b) => a.id - b.id);
            const [canonical, ...rest] = rows;
            for (const row of rest) {
              delete row.loudness;
              store.put({
                ...row,
                blob: canonical.blob,
                hash: canonical.hash,
              });
            }
            resolve(rows.map((row) => row.id));
            db.close();
          };
        };
      }),
  );
}

test.describe("duplicate audio maintenance", () => {
  test("collapses a duplicate and leaves the re-pointed pad playing", async ({
    page,
  }) => {
    await gotoApp(page);

    // Two pads, two genuinely different sounds — `createTestAudioFilePath`
    // derives its waveform from the name, so these do not collapse on import.
    for (const [padIndex, name] of [
      [0, "dedup-alpha"],
      [1, "dedup-bravo"],
    ] as const) {
      await openEditPadModal(page, padIndex);
      await addSoundsToPadModal(page, [await createTestAudioFilePath(name)]);
      await savePadEditModal(page);
    }

    const before = await countAudioFiles(page);
    expect(before).toBeGreaterThanOrEqual(2);
    const ids = await makeEveryRowTheSameSound(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // A fresh load, so nothing under test is reading a cache warmed from the
    // rows as they were before the fixture rewrote them.
    await page.reload();

    await openProfileManager(page);
    await page.getByRole("button", { name: "Maintenance" }).click();

    await page.locator('[data-testid="duplicate-audio-scan"]').click();
    const preview = page.locator('[data-testid="duplicate-audio-preview"]');
    await expect(preview).toContainText("1 group");
    await expect(preview).toContainText("1 copy");
    // The warning is the whole safety story, so it is asserted rather than
    // assumed to have rendered.
    await expect(preview).toContainText("permanently");

    const collapse = page.locator('[data-testid="duplicate-audio-collapse"]');
    await expect(collapse).toContainText("Remove 1 Copy");

    // The browser's own confirmation, not a component's idea of one.
    let asked = "";
    page.once("dialog", (dialog) => {
      asked = dialog.message();
      void dialog.accept();
    });
    await collapse.click();

    await expect(
      page.locator('[data-testid="duplicate-audio-result"]'),
    ).toContainText("Removed 1 copy");
    expect(asked).toContain("cannot be undone");
    expect(await countAudioFiles(page)).toBe(before - 1);

    // The half no jsdom test can reach: the pad whose row was deleted, played
    // without a reload, through whatever copy of the pad configurations the
    // board and the keyboard listener are holding.
    // `getByLabel`, not `getByRole(… "Close")`: the manager has two of those,
    // the header's X and the footer's button, and the role query matches both.
    await page.getByLabel("Close").click();
    await expect(
      page.getByRole("heading", { name: "Profile Manager" }),
    ).toBeHidden();
    await activatePad(page, page.locator('[id^="pad-"][id$="-1"]'));
  });
});
