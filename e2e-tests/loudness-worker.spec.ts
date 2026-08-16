import { test, expect } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  openEditPadModal,
  addSoundsToPadModal,
  savePadEditModal,
} from "./test-helpers";

/**
 * Loudness analysis must actually reach the worker in a production build.
 *
 * `analyseOffThread` falls back to the main thread whenever the worker cannot
 * be had — deliberately, because analysis silently not happening would leave
 * every sound unnormalised. The cost of that kindness is that a worker which
 * never loads looks exactly like one that works: same results, no error, just
 * ~2.2 seconds of blocking arithmetic per minute of stereo audio, on the
 * thread that is also rendering and feeding Web Audio.
 *
 * So this asserts on which path served the analysis, not on whether one
 * happened. Nothing below the built app can tell the difference: the unit
 * tests exercise the fallback quite happily, and the bundler is the only part
 * that decides whether the worker is real.
 */
test.describe("the loudness worker", () => {
  test("serves analysis off the main thread in a production build", async ({
    page,
  }) => {
    // A worker that 404s or will not parse surfaces nowhere else — the
    // fallback swallows it — so watch the network directly.
    // Static assets only: /api/auth/session answers 401 for the signed-out
    // browser every spec runs in, which says nothing about the worker.
    const badResponses: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().includes("/_next/")) {
        badResponses.push(`${response.url()} — ${response.status()}`);
      }
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await gotoApp(page);
    await prepareAudioContext(page);

    await openEditPadModal(page, 0);
    await addSoundsToPadModal(page, [
      await createTestAudioFilePath("workerAnalysis"),
    ]);
    await savePadEditModal(page);

    const readCounts = () =>
      page.evaluate(() => {
        const read = (
          window as unknown as {
            __impampLoudnessAnalysis?: () => {
              byWorker: number;
              onMainThread: number;
            };
          }
        ).__impampLoudnessAnalysis;
        return read ? read() : { byWorker: 0, onMainThread: 0 };
      });

    // Adding a sound schedules exactly one analysis, in the background. Wait
    // for it to land on *either* path before asking which — polling the total
    // is what makes the assertion below a result rather than a race.
    await expect
      .poll(
        async () => {
          const { byWorker, onMainThread } = await readCounts();
          return byWorker + onMainThread;
        },
        {
          message: "no analysis was served by either path",
          timeout: 30_000,
        },
      )
      .toBeGreaterThan(0);

    const served = await readCounts();

    // The regression: byWorker 0, onMainThread 1.
    expect(
      served.onMainThread,
      "analysis fell back to the main thread — the worker did not load",
    ).toBe(0);
    expect(served.byWorker).toBeGreaterThan(0);

    expect(badResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
