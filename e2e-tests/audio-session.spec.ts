import { test, expect } from "@playwright/test";
import {
  activatePad,
  createTestAudioFilePath,
  gotoApp,
  prepareAudioContext,
} from "./test-helpers";

/**
 * The declaration that keeps an iPhone audible with its ringer switch on
 * silent.
 *
 * Safari's default audio session type is `"auto"`, which for a page whose only
 * output is Web Audio resolves to `"ambient"` — the one category the hardware
 * switch mutes. The board then looks entirely healthy and makes no sound: the
 * context runs, the pad lights up, the progress bar sweeps, Active Tracks
 * fills. `src/lib/audio/audioSession.ts` declares `"playback"` instead, and
 * `getAudioContext` calls it immediately before building the context, because
 * iOS picks the route as the context comes up.
 *
 * No Playwright browser implements the Audio Session API, so the API itself
 * has to be stood in for. What this spec proves that the unit tests cannot is
 * that the call survives into the shipped bundle and is reached by the ordinary
 * route a cue takes — a pad press — rather than only by a module a test
 * imported directly. The stand-in is a plain object with a `type`, which is
 * the whole of the API surface used.
 */

/** The page globals this spec installs and then reads back. */
type ProbedWindow = typeof window & {
  __sessionTypeAtContextConstruction?: string | null;
};

/** `navigator` with the stand-in Audio Session API attached. */
type ProbedNavigator = Navigator & { audioSession?: { type: string } };

test.describe("iOS audio session", () => {
  test("is declared playback before the first AudioContext is built", async ({
    page,
  }) => {
    // Added before gotoApp: init scripts run in the order they are registered,
    // and this one has to be in place before any application code evaluates.
    await page.addInitScript(() => {
      const session = { type: "auto" };
      Object.defineProperty(navigator, "audioSession", {
        configurable: true,
        writable: true,
        value: session,
      });

      // The construction order is the load-bearing half, so it is recorded
      // from inside the constructor rather than read afterwards: a declaration
      // made after `new AudioContext()` would leave this snapshot on "auto"
      // while the final reading still said "playback".
      const probed = window as typeof window & {
        __sessionTypeAtContextConstruction?: string | null;
      };
      probed.__sessionTypeAtContextConstruction = null;
      const RealAudioContext = window.AudioContext;
      class RecordingAudioContext extends RealAudioContext {
        constructor(...args: ConstructorParameters<typeof RealAudioContext>) {
          if (probed.__sessionTypeAtContextConstruction === null) {
            probed.__sessionTypeAtContextConstruction = session.type;
          }
          super(...args);
        }
      }
      window.AudioContext = RecordingAudioContext;
    });

    await gotoApp(page);
    await prepareAudioContext(page);

    const fileName = "SilentSwitchCue";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const firstPad = page.locator('[id^="pad-"]').first();
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(audioFilePath);
    await expect(firstPad).toContainText(fileName);

    await activatePad(page, firstPad);
    await expect(firstPad.locator(".bg-green-500")).toBeVisible();

    expect(
      await page.evaluate(
        () => (window as ProbedWindow).__sessionTypeAtContextConstruction,
      ),
    ).toBe("playback");
    expect(
      await page.evaluate(
        () => (navigator as ProbedNavigator).audioSession?.type,
      ),
    ).toBe("playback");
  });
});
