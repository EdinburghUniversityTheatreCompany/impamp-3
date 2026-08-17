import { test, expect, Page } from "@playwright/test";
import {
  gotoApp,
  waitForAppReady,
  prepareAudioContext,
  createTestAudioFilePath,
  activatePad,
  getActiveSounds,
} from "./test-helpers";

/**
 * A trimmed streamed track has to end on time when the tab is not painting.
 *
 * Two pipelines play a pad, and they enforce a trim end completely
 * differently. A decoded buffer gets its window from
 * `source.start(when, offset, duration)`, which the audio thread honours
 * whatever the main thread is doing. A media element has no equivalent, so the
 * end point was policed from `playbackLoopTick` — scheduled purely by
 * `requestAnimationFrame`, which a browser stops calling in a hidden tab while
 * `context.ts` deliberately keeps the audio running. During a show this board
 * sits behind other windows for whole scenes, and the tail that was trimmed
 * off is usually the part that must never go to air.
 *
 * Getting a browser to take the streaming path on demand is the awkward part:
 * `PadGrid` preloads the current bank, so by the time a test can click, the
 * decoded buffer is normally already cached and the pad takes the other route
 * entirely. Failing `decodeAudioData` is what makes it deterministic — no
 * decoded buffer can ever be cached, so playback must stream, which is exactly
 * the production condition for any pad the preloader has not reached yet. The
 * media element decodes the file itself and is unaffected.
 */

const TRIM_END_SECONDS = 3;
const FILE_SECONDS = 20;

/** Stops the browser producing frames, which is all a hidden tab really is. */
async function stopAnimationFrames(page: Page) {
  await page.evaluate(() => {
    window.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  });
}

/**
 * Trims the sound on pad 0 by editing its stored configuration directly.
 *
 * The trimmer is a drag-driven waveform overlay; driving it by mouse to land
 * on an exact number of seconds would test the trimmer, not the trim.
 */
async function setPad0TrimEnd(page: Page, trimEnd: number) {
  await page.evaluate(async (end) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("impamp3DB");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("padConfigurations", "readwrite");
      const store = tx.objectStore("padConfigurations");
      const all = store.getAll();
      all.onsuccess = () => {
        const config = all.result.find(
          (pad) => pad.padIndex === 0 && pad.audioFileIds?.length,
        );
        if (!config) {
          reject(new Error("pad 0 has no sound to trim"));
          return;
        }
        config.audioTrimSettings = {
          [config.audioFileIds[0]]: { trimStart: 0, trimEnd: end },
        };
        store.put(config);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, trimEnd);
}

test.describe("a streamed track's trim end", () => {
  test("cuts the sound off even with no animation frames at all", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      AudioContext.prototype.decodeAudioData = () =>
        Promise.reject(new Error("e2e: forcing the streaming playback path"));
    });

    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "streamed-trim";
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(await createTestAudioFilePath(fileName, FILE_SECONDS));
    const pad = page.locator('[id^="pad-"][id$="-0"]');
    await expect(pad).toContainText(fileName);

    await setPad0TrimEnd(page, TRIM_END_SECONDS);
    await page.reload();
    await waitForAppReady(page);
    await prepareAudioContext(page);

    await activatePad(page, pad);

    // Without this the test could pass on the buffer path, which has never
    // had the bug — `source.start` carries the trim window natively.
    const playing = await getActiveSounds(page);
    expect(playing).toHaveLength(1);
    expect((playing[0] as { sourceKind?: string }).sourceKind).toBe("media");

    await stopAnimationFrames(page);

    // Policed only from a frame, this runs to the end of a 20-second file and
    // is cut off whenever the tab is next looked at.
    await expect
      .poll(async () => (await getActiveSounds(page)).length, {
        timeout: 12_000,
        intervals: [200],
      })
      .toBe(0);
  });
});
