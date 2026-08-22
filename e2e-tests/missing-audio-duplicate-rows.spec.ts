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
 * One pad naming one *missing* audio row twice, in the Maintenance panel.
 *
 * A pad can hold the same audio id twice — add the same bytes again and
 * `addOrReuseAudioFile` hands back the row that is already there — and when
 * that row goes, `findMissingAudioFiles` reports the reference once per
 * occurrence. The panel keyed every row on
 * `profile-bank-pad-missingId`, which is the same string for both, so the two
 * rows shared a React key and a `data-testid`.
 *
 * That is the collision `EditPadForm` mints its `rowId` for, and the failure
 * no jsdom test can produce: a duplicate `data-testid` is a Playwright strict
 * mode violation, so the panel simply stops being addressable — by a spec, and
 * by anything else driving the page.
 *
 * The repair itself is deliberately *not* per-row: `replaceMissingAudioFile`
 * swaps every occurrence of the id in the pad, so one file genuinely fixes
 * both references. The rows therefore have their own identity on screen and
 * share the state of the reference underneath them, which is what the second
 * half of this spec pins.
 */

/** Empties the `audioFiles` store, leaving every pad naming ids that are gone. */
async function forgetEveryStoredSound(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("impamp3DB");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("audioFiles", "readwrite");
          tx.objectStore("audioFiles").clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

/** The `data-testid` of every replacement picker the panel is showing. */
async function listedReplaceIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="missing-audio-replace-"]')
    .evaluateAll((inputs) =>
      inputs.map((input) => input.getAttribute("data-testid") ?? ""),
    );
}

test("a pad naming one missing sound twice lists two addressable rows", async ({
  page,
}) => {
  await gotoApp(page);
  const soundName = "missing-twice-in-one-pad";
  const file = await createTestAudioFilePath(soundName);

  await openEditPadModal(page, 0);
  await addSoundsToPadModal(page, [file]);
  await savePadEditModal(page);

  // The same file again: one audio row, listed twice on the pad.
  await openEditPadModal(page, 0);
  await page.locator("#addSoundsInput").setInputFiles(file);
  await expect(
    page.locator('[data-testid^="edit-pad-sound-item-"]'),
  ).toHaveCount(2);
  await savePadEditModal(page);
  expect(await countAudioFiles(page)).toBe(1);

  // The library loses its audio — a restore without the blobs, an evicted
  // origin, a Drive download that never finished. The pad still names the id,
  // twice, and plays nothing.
  await forgetEveryStoredSound(page);
  await page.reload();

  await openProfileManager(page);
  await page.getByRole("button", { name: "Maintenance" }).click();
  await page.locator('[data-testid="missing-audio-scan"]').click();

  const rows = page.locator('[data-testid="missing-audio-row"]');
  await expect(rows).toHaveCount(2);

  const replaceIds = await listedReplaceIds(page);
  expect(replaceIds).toHaveLength(2);
  // What actually fires when the ids collide is the strict locator below —
  // "resolved to 2 elements" — which reads as a flaky selector unless
  // something nearby says what it means.
  expect(new Set(replaceIds).size, "the two rows share a test id").toBe(2);
  for (const id of replaceIds) {
    await expect(page.getByTestId(id)).toHaveCount(1);
  }

  // One file repairs both references, because `replaceMissingAudioFile` swaps
  // every occurrence of the id in the pad. The rows have their own identity;
  // the reference they name is one thing, and both say so.
  await page.getByTestId(replaceIds[0]).setInputFiles(file);
  await expect(rows.first()).toContainText("Replaced");
  await expect(rows.last()).toContainText("Replaced");
  expect(await countAudioFiles(page)).toBe(1);

  // The half that matters to the operator: the pad plays again, without a
  // reload, through whatever copy of the pad configurations the board and the
  // keyboard listener are holding.
  await page.getByLabel("Close").click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeHidden();
  await activatePad(page, page.locator('[id^="pad-"][id$="-0"]'));
});
