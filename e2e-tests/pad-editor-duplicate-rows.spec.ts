import { test, expect, type Page } from "@playwright/test";
import {
  addSoundsToPadModal,
  countAudioFiles,
  createTestAudioFilePath,
  gotoApp,
  openEditPadModal,
  prepareAudioContext,
  savePadEditModal,
} from "./test-helpers";

/**
 * One pad naming one audio row twice, driven through the editor.
 *
 * A pad that plays a sound twice in a round is a thing users ask for, and
 * reuse by content hash makes it trivial to arrive at: adding the same bytes
 * again returns the row that is already there, so `audioFileIds` holds one id
 * twice. Every row-naming id in the editor is therefore built from a `rowId`
 * of `${fileId}-${occurrence}` rather than from the file id alone.
 *
 * No other spec has ever built that pad, which is why the collision could sit
 * in the tree unnoticed for a release: with `${fileId}` ids the four
 * `data-testid`s below each answer two elements, and a Playwright locator
 * refuses that with "strict mode violation: … resolved to 2 elements". The
 * jsdom suite (`EditPadForm.dedup.test.tsx`) checks the same ids by counting
 * matches; this one checks that the app the user gets is addressable, and that
 * naming the second copy's Trim or Remove button acts on the second copy.
 */

/** The `rowId` of every sound row currently listed, in display order. */
async function listedRowIds(page: Page): Promise<string[]> {
  const testIds = await page
    .locator('[data-testid^="edit-pad-sound-item-"]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-testid") ?? ""),
    );
  return testIds.map((id) => id.replace("edit-pad-sound-item-", ""));
}

test("a pad naming one sound twice gives each row its own controls", async ({
  page,
}) => {
  await gotoApp(page);
  await prepareAudioContext(page);
  const soundName = "twice-in-one-pad";
  const file = await createTestAudioFilePath(soundName);

  await openEditPadModal(page, 0);
  await addSoundsToPadModal(page, [file]);
  await savePadEditModal(page);

  // The same file again. `addOrReuseAudioFile` hands back the row the save
  // above wrote, so this is one audio row listed twice rather than two rows.
  await openEditPadModal(page, 0);
  await page.locator("#addSoundsInput").setInputFiles(file);
  const rows = page.locator('[data-testid^="edit-pad-sound-item-"]');
  await expect(rows).toHaveCount(2);
  await savePadEditModal(page);
  expect(await countAudioFiles(page)).toBe(1);

  // Reopened, so the list is rebuilt from the stored `audioFileIds` — the path
  // a fresh session takes, and the one where the duplicate arrives from the
  // database rather than from the picker.
  await openEditPadModal(page, 0);
  await expect(rows).toHaveCount(2);
  const rowIds = await listedRowIds(page);

  // Every id a spec can reach, resolved one at a time. Each of these is a
  // strict locator: a duplicate id fails here rather than at some later step
  // that happens to click the wrong copy.
  for (const rowId of rowIds) {
    await expect(
      page.getByTestId(`edit-pad-sound-item-${rowId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`edit-pad-gain-sound-${rowId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`edit-pad-trim-sound-${rowId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`edit-pad-remove-sound-${rowId}`),
    ).toBeVisible();
  }

  // The same fact stated plainly. The loop above is what actually fires when
  // the ids collide — "resolved to 2 elements", on the first of the four — but
  // that reads as a flaky locator unless something nearby says what it means.
  expect(new Set(rowIds).size, "the two rows share a test id").toBe(2);

  // Addressable is not the whole claim: the control named has to be the one
  // that acts. The second copy's Trim opens the trimmer...
  await page.getByTestId(`edit-pad-trim-sound-${rowIds[1]}`).click();
  const trimmer = page.getByText(`Trim: ${soundName}`);
  await expect(trimmer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trimmer).toBeHidden();

  // ...and the second copy's Remove takes out that copy alone. Removing every
  // row naming the sound is what the collision used to do, because the handler
  // matched on the id the two rows shared.
  await page.getByTestId(`edit-pad-remove-sound-${rowIds[1]}`).click();
  await expect(rows).toHaveCount(1);
  await expect(
    page.getByTestId(`edit-pad-sound-item-${rowIds[0]}`),
  ).toBeVisible();

  await savePadEditModal(page);
  await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(soundName);
});
