import { test, expect, Page, Locator } from "@playwright/test";
import {
  gotoApp,
  prepareAudioContext,
  createTestAudioFilePath,
  enterEditMode,
  exitEditMode,
  savePadEditModal,
  setProfileActivePadBehavior,
  getActiveSounds,
} from "./test-helpers";
import { MAX_LAYERS_PER_PAD } from "../src/lib/audio/types";

/**
 * Layering, driven through a real browser.
 *
 * The unit suite proves the engine (`playback.layers.test.ts`,
 * `controls.layerEngine.test.ts`) and the panel's fold
 * (`ActiveTracksPanel.grouping.test.tsx`). What no jsdom test can reach is the
 * chain from a real input event to a real instance key: a browser's own
 * auto-repeat, a click landing on the pad, the profile's stored default being
 * read at trigger time. This spec covers exactly that chain, and deliberately
 * covers the parts of it a hand-check would not think to try.
 *
 * What is NOT here, because `layer-count-row.spec.ts` already owns it: the
 * group row's layout — that the count badge and the remaining time occupy
 * disjoint boxes — and the expand/collapse interaction on the count button.
 * That spec sets a pad to Layer and presses it five times; this one never
 * repeats that particular shape.
 *
 * The negative control at the bottom is what makes the rest mean anything.
 * Without it, "three presses gave three sounds" cannot be told apart from
 * "three presses would give three sounds under any setting", and every
 * assertion above would survive an implementation that ignored the setting
 * entirely. `controls.layerEngine.test.ts` carries the same control at the
 * unit level for the same reason.
 */

/** The pad's playing instances, in the order the engine registered them. */
async function liveKeys(page: Page): Promise<string[]> {
  return (await getActiveSounds(page)).map((sound) => sound.key);
}

/**
 * Waits until the app's own clock has advanced by a whole displayed second.
 *
 * The negative control needs a window in which a layer *would* have appeared
 * if the behaviour were wrong, and its assertions are all "still only one", so
 * they resolve on their first poll and prove nothing on their own. A flat
 * sleep would be load-bearing in disguise. Waiting for the remaining-time
 * readout to tick proves two things instead: playback is genuinely still
 * running (a stopped track's row is gone and this times out loudly), and a
 * second of audio has elapsed since the press — orders of magnitude longer
 * than registering a layer takes, and measured by the app rather than by how
 * busy the machine is. Borrowed from `playbackHasProgressed` in
 * audio-playback.spec.ts, which exists for the same reason.
 */
async function aDisplayedSecondElapses(page: Page) {
  const row = page.getByTestId("active-track-item").first();
  const before = await row.innerText();
  await expect.poll(() => row.innerText()).not.toBe(before);
}

/** Drops a sound on pad 0 and returns the pad. */
async function padWithSound(page: Page, fileName: string): Promise<Locator> {
  await page
    .locator('[data-testid="pad-drop-input-0"]')
    .setInputFiles(await createTestAudioFilePath(fileName));
  const pad = page.locator('[id^="pad-"][id$="-0"]');
  await expect(pad).toContainText(fileName);
  return pad;
}

/** Gives pad 0 its own "Layer Sounds" override, overriding the profile. */
async function setPadBehaviorToLayer(page: Page, pad: Locator) {
  await enterEditMode(page);
  await pad.click();
  await page.locator('[data-testid="edit-pad-active-behavior-layer"]').check();
  await savePadEditModal(page);
}

test.describe("a pad that layers", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  test(`stacks up to ${MAX_LAYERS_PER_PAD} layers and then steals the oldest`, async ({
    page,
  }) => {
    const pad = await padWithSound(page, "cap-me");
    await setPadBehaviorToLayer(page, pad);

    // The first press takes the pad's bare base key; layers take `base#n`.
    await pad.click();
    await expect.poll(() => liveKeys(page)).toHaveLength(1);
    const base = (await liveKeys(page))[0];
    expect(base).not.toContain("#");

    // Fill the pad to the cap. Each press waits for the previous one to
    // register: `allocateLayerKey` only runs when the pad reads as already
    // playing, so pressing faster than the engine registers would silently
    // take the single-instance path and this would stop testing layering.
    for (let layer = 1; layer < MAX_LAYERS_PER_PAD; layer++) {
      await pad.click();
      const expected = [base];
      for (let n = 1; n <= layer; n++) expected.push(`${base}#${n}`);
      await expect.poll(() => liveKeys(page)).toEqual(expected);
    }

    // The panel and the pad both say so, and both are visible rather than
    // merely present — this row is where an absolutely-positioned badge once
    // sat on top of the remaining time while the text still read correctly.
    const panelCount = page.getByTestId("active-track-layer-count");
    await expect(panelCount).toBeVisible();
    await expect(panelCount).toHaveText(`x${MAX_LAYERS_PER_PAD}`);
    const padCount = page.getByTestId("pad-layer-count");
    await expect(padCount).toBeVisible();
    await expect(padCount).toHaveText(`x${MAX_LAYERS_PER_PAD}`);

    // One more. The cap holds, and it is the *oldest* instance that goes:
    // the bare base key is gone, `#1` is now the oldest survivor, and a new
    // `#16` is on the end. An unbounded cap gives 17 keys; stealing the
    // newest, or an arbitrary one, gives a different list of 16.
    await pad.click();
    const afterSteal: string[] = [];
    for (let n = 1; n <= MAX_LAYERS_PER_PAD; n++)
      afterSteal.push(`${base}#${n}`);
    await expect.poll(() => liveKeys(page)).toEqual(afterSteal);

    // Still one row for the pad, still reading the cap.
    await expect(page.getByTestId("active-track-item")).toHaveCount(1);
    await expect(panelCount).toHaveText(`x${MAX_LAYERS_PER_PAD}`);
  });

  test("does not restack while its key is held down", async ({ page }) => {
    const pad = await padWithSound(page, "held-key");
    await setPadBehaviorToLayer(page, pad);

    // A held key is a deliberate decision, not a side effect: an operator
    // leaning on a pad key must get one sound, not one per auto-repeat, and
    // for a layering pad the consequence of getting it wrong is sixteen
    // copies and a stolen oldest layer within a second. Playwright's
    // `keyboard.down` sets `autoRepeat` on every call after the first for the
    // same key, so these really are `repeat: true` events — the only way to
    // reach `Pad.tsx`'s guard, and the reason this test cannot be a unit test
    // that hand-builds an event object with `repeat: true` on it.

    // Route 1: the global keyboard listener, via the pad's own hotkey.
    //
    // The repeats here are spaced a whole displayed second apart, and that
    // spacing is the entire point. `useKeyboardListener` also holds a 100ms
    // `keyDebounceMap` per key, which swallows anything arriving at an OS
    // auto-repeat rate — so a burst of repeats fired back to back passes
    // whether the `event.repeat` guard is there or not. It was written that
    // way first, and deleting the guard left it green. Spacing the repeats
    // past the debounce window leaves the guard as the only thing that can
    // suppress them.
    await page.keyboard.down("q");
    await expect.poll(() => liveKeys(page)).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      await aDisplayedSecondElapses(page);
      await page.keyboard.down("q");
    }
    await aDisplayedSecondElapses(page);
    await expect.poll(() => liveKeys(page)).toHaveLength(1);
    await page.keyboard.up("q");

    // A fresh press does layer — so the assertion above is about auto-repeat
    // and not about the key being inert.
    await page.keyboard.press("q");
    await expect.poll(() => liveKeys(page)).toHaveLength(2);

    // Route 2: a focused pad's own Enter handler, which stops propagation and
    // so never reaches the listener exercised above.
    await pad.focus();
    await page.keyboard.down("Enter");
    await expect.poll(() => liveKeys(page)).toHaveLength(3);
    // Nothing debounces this route today, so a back-to-back burst would prove
    // the guard here. Spaced anyway, so that adding a debounce to the pad
    // later cannot quietly turn this assertion into the inert one route 1 was.
    for (let i = 0; i < 2; i++) {
      await aDisplayedSecondElapses(page);
      await page.keyboard.down("Enter");
    }
    await aDisplayedSecondElapses(page);
    await expect.poll(() => liveKeys(page)).toHaveLength(3);
    await page.keyboard.up("Enter");

    await page.keyboard.press("Enter");
    await expect.poll(() => liveKeys(page)).toHaveLength(4);
  });

  test("layers on the profile's default when it has no override of its own", async ({
    page,
  }) => {
    await setProfileActivePadBehavior(page, "layer");
    const pad = await padWithSound(page, "profile-default");

    // Prove the pad really is following the profile rather than carrying an
    // override — the whole point of this test is the resolution step, and
    // without this it would pass just as well if dropping a file stamped
    // "layer" onto the pad.
    await enterEditMode(page);
    await pad.click();
    await expect(
      page.locator('[data-testid="edit-pad-active-behavior-"]'),
    ).toBeChecked();
    await page.locator('[data-testid="modal-cancel-button"]').click();
    await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
    await exitEditMode(page);

    await pad.click();
    await expect.poll(() => liveKeys(page)).toHaveLength(1);
    const base = (await liveKeys(page))[0];

    await pad.click();
    await expect.poll(() => liveKeys(page)).toEqual([base, `${base}#1`]);
    await pad.click();
    await expect
      .poll(() => liveKeys(page))
      .toEqual([base, `${base}#1`, `${base}#2`]);

    await expect(page.getByTestId("active-track-item")).toHaveCount(1);
    await expect(page.getByTestId("active-track-layer-count")).toHaveText("x3");
  });
});

/**
 * The control. Every other behaviour must refuse to stack, or "it layered"
 * above is unfalsifiable.
 */
test.describe("a pad that does not layer", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  for (const behavior of ["continue", "restart"] as const) {
    test(`never stacks under "${behavior}"`, async ({ page }) => {
      await setProfileActivePadBehavior(page, behavior);
      const pad = await padWithSound(page, `no-stack-${behavior}`);

      await pad.click();
      await expect.poll(() => liveKeys(page)).toHaveLength(1);
      const base = (await liveKeys(page))[0];

      // Two more presses of a pad that is already playing. Under "layer" this
      // is what produces `base#1` and `base#2`; here the pad must still own
      // exactly one instance, on its bare key.
      for (let press = 0; press < 2; press++) {
        await pad.click();
        await aDisplayedSecondElapses(page);
        expect(await liveKeys(page)).toEqual([base]);
      }

      // And no grouped row, because there is nothing to group.
      await expect(page.getByTestId("active-track-item")).toHaveCount(1);
      await expect(page.getByTestId("active-track-layer-count")).toHaveCount(0);
      await expect(page.getByTestId("pad-layer-count")).toHaveCount(0);
    });
  }

  test('never stacks under "stop"', async ({ page }) => {
    await setProfileActivePadBehavior(page, "stop");
    const pad = await padWithSound(page, "no-stack-stop");

    await pad.click();
    await expect.poll(() => liveKeys(page)).toHaveLength(1);
    const base = (await liveKeys(page))[0];

    // "stop" needs no elapsed-time window: the second press emptying the
    // registry is itself positive proof it landed, and a press that layered
    // instead would leave two.
    await pad.click();
    await expect.poll(() => liveKeys(page)).toEqual([]);

    await pad.click();
    await expect.poll(() => liveKeys(page)).toEqual([base]);

    await expect(page.getByTestId("active-track-layer-count")).toHaveCount(0);
    await expect(page.getByTestId("pad-layer-count")).toHaveCount(0);
  });
});
