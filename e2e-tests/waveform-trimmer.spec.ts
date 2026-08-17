import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  openEditPadModal,
} from "./test-helpers";

/**
 * Escape backs out of the trimmer, and only the trimmer.
 *
 * `WaveformTrimmer` portals a second overlay on top of the pad-edit modal and
 * registered no keydown handler of its own, so Escape while trimming was
 * handled by the modal underneath — which closed the entire pad editor and
 * discarded the trim range along with every other unsaved change on that pad:
 * name, playback mode, gains, sound order. The trimmer's Cancel button was the
 * only safe way out, and nothing said so.
 *
 * The review expected this to fix itself once the trimmer registered a
 * capture-phase handler, on the grounds that it mounts later. It does not:
 * among capture listeners on the same target the *earlier* registration wins,
 * and that is the modal. Escape ownership has to be a stack, which is what
 * `useEscapeToClose` now keeps.
 */
test.describe("Escape inside the waveform trimmer", () => {
  test("closes the trimmer and leaves the pad editor open", async ({
    page,
  }) => {
    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "trim-escape";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName));
    await expect(page.locator('[id^="pad-"][id$="-0"]')).toContainText(
      fileName,
    );

    await openEditPadModal(page, 0);
    const editor = page.getByRole("dialog");
    await expect(editor).toBeVisible();

    await page.getByTestId("edit-pad-trim-sound-1").click();
    const trimmer = page.getByText(`Trim: ${fileName}`);
    await expect(trimmer).toBeVisible();

    await page.keyboard.press("Escape");

    // The trimmer goes...
    await expect(trimmer).toBeHidden();
    // ...and the editor, with everything unsaved in it, stays.
    await expect(editor).toBeVisible();

    // A second Escape now belongs to the editor, which is the layer below.
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
  });
});
