import { test, expect } from "@playwright/test";
import {
  activatePad,
  addSoundsToPadModal,
  countAudioFiles,
  createTestAudioFilePath,
  exitEditMode,
  gotoApp,
  openEditPadModal,
  savePadEditModal,
} from "./test-helpers";

/**
 * Dismissing the pad editor must not delete a sound something else still uses.
 *
 * The editor writes each added file to IndexedDB as it is picked and discards
 * the ids again on unmount, which was safe only while every add minted a fresh
 * row. Once adds went through `addOrReuseAudioFile`, a "provisional" id became
 * routinely the id of a row that already existed and was already referenced —
 * so pressing Escape deleted audio the board was using. The fix was to discard
 * through `deleteUnreferencedAudioFiles`, and it has unit tests driving the
 * component.
 *
 * What those cannot see is the routing: whether Escape actually reaches the
 * unmount path in the running app, and whether the pad plays afterwards. This
 * is the single-profile case, which needs no unusual setup at all — a pad that
 * already holds a sound, the same file added to it again, Escape.
 */
test("re-adding a pad's own sound and escaping leaves the pad playing", async ({
  page,
}) => {
  await gotoApp(page);
  const file = await createTestAudioFilePath("reuse-discard-horn");

  await openEditPadModal(page, 0);
  await addSoundsToPadModal(page, [file]);
  await savePadEditModal(page);
  const afterSave = await countAudioFiles(page);

  // The same file again. Nothing new is stored — the add resolves to the row
  // the save above wrote — so the id the editor would discard is the pad's own.
  await openEditPadModal(page, 0);
  await addSoundsToPadModal(page, [file]);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
  await exitEditMode(page);

  expect(await countAudioFiles(page)).toBe(afterSave);
  await activatePad(page, page.locator('[id^="pad-"][id$="-0"]'));
});
