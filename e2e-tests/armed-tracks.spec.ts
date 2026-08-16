import { test, expect, Page } from "@playwright/test";
import {
  createTestAudioFilePath,
  prepareAudioContext,
  createAndSwitchToProfile,
  createMultipleTestAudioFiles,
  getActiveSounds,
  getAudioCacheState,
  gotoApp,
} from "./test-helpers";

// ------ Helper Functions for Arming Tests ------

/**
 * Helper to arm a pad using Ctrl+Click
 */
async function armPad(page: Page, padIndex: number): Promise<void> {
  const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);

  // Ctrl+Click only arms a pad that already holds sound: Pad's click handler
  // requires isConfigured && soundCount > 0, and on a pad that has not picked
  // up its configuration yet the modifier is ignored and the click *plays* the
  // pad instead. Loading a file and arming in the same breath is therefore a
  // race, so wait for the pad to stop being empty first.
  await expect(pad).not.toContainText("Empty Pad");

  await page.keyboard.down("Control");
  await pad.click();
  await page.keyboard.up("Control");

  // Confirm the pad really is armed — the star indicator — rather than
  // assuming a fixed delay was long enough.
  await expect(pad.locator(".text-amber-500")).toBeVisible();
  console.log(`[Test Helper] Armed pad ${padIndex}`);
}

/**
 * Helper to check if a pad is visually indicated as armed (star indicator)
 */
async function isPadArmed(page: Page, padIndex: number): Promise<boolean> {
  const pad = page.locator(`[id^="pad-"][id$="-${padIndex}"]`);
  const armedIndicator = pad.locator(".text-amber-500");
  return await armedIndicator.isVisible();
}

/**
 * Helper to get the names of all armed tracks from the panel
 */
async function getArmedTrackNames(page: Page): Promise<string[]> {
  // First check if panel is even visible (it disappears when empty)
  const panel = page.locator('[data-testid="armed-tracks-panel"]');
  const isVisible = await panel.isVisible();
  if (!isVisible) {
    return [];
  }

  // Get all tracks from the panel
  const trackItems = panel.locator(".font-medium.text-gray-800");
  const count = await trackItems.count();
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    const name = await trackItems.nth(i).textContent();
    if (name) {
      // Remove the "armed" text that appears next to the name
      const cleanName = name.replace("armed", "").trim();
      names.push(cleanName);
    }
  }

  return names;
}

/**
 * Helper to arm a track from search results
 */
async function armTrackFromSearch(
  page: Page,
  searchTerm: string,
  resultIndex: number = 0,
): Promise<void> {
  // Open search modal
  await page.keyboard.press("Control+f");

  // Wait for search modal to appear
  const searchModal = page.locator('[data-testid="search-modal"]');
  await expect(searchModal).toBeVisible();

  // Type search term
  const searchInput = searchModal.locator('input[type="text"]');
  await searchInput.fill(searchTerm);

  // Wait for the result itself rather than a fixed delay — search runs against
  // every bank, so how long it takes depends on how much is loaded.
  const searchResults = page.locator('[data-testid="search-result-item"]');
  await expect(searchResults.nth(resultIndex)).toBeVisible();

  // Arm the specified result using Ctrl+Click
  await page.keyboard.down("Control");
  await searchResults.nth(resultIndex).click();
  await page.keyboard.up("Control");

  // Modal should close after arming
  await expect(searchModal).not.toBeVisible();
  console.log(
    `[Test Helper] Armed track from search results for term: ${searchTerm}`,
  );
}

/**
 * Helper to click the play button on an armed track in the panel
 */
async function clickPlayOnArmedTrack(
  page: Page,
  trackName: string,
): Promise<void> {
  const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
  await expect(armedPanel).toBeVisible();

  // Find the track item containing the name
  const trackItem = armedPanel.locator(`:has-text("${trackName}")`).first();
  await expect(trackItem).toBeVisible();

  // Click the play button (green button with play icon)
  const playButton = page.getByRole("button", { name: `Play ${trackName}` });
  await playButton.click();
  console.log(
    `[Test Helper] Clicked play button for armed track: ${trackName}`,
  );
}

/**
 * Helper to click the remove button on an armed track in the panel
 */
async function clickRemoveOnArmedTrack(
  page: Page,
  trackName: string,
): Promise<void> {
  const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
  await expect(armedPanel).toBeVisible();

  // Find the track item containing the name
  const trackItem = armedPanel.locator(`:has-text("${trackName}")`).first();
  await expect(trackItem).toBeVisible();

  // Click the remove button (red button with X icon)
  const removeButton = trackItem.locator("button.bg-red-500");
  await removeButton.click();
  console.log(
    `[Test Helper] Clicked remove button for armed track: ${trackName}`,
  );
}

// ------ Test Suite ------

test.describe("ImpAmp3 Track Arming Feature", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);

    // Prepare the audio context for testing
    await prepareAudioContext(page);
  });

  test("UI - Armed Tracks Panel is hidden when empty", async ({ page }) => {
    // Verify the Armed Tracks Panel is not visible initially
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).not.toBeVisible();
  });

  test("Can arm a track using Ctrl+Click", async ({ page }) => {
    // Create and load an audio file to a pad
    const fileName = "arm-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const pad = page.locator('[id^="pad-"]').first();
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(pad).toContainText(fileName);

    // Arm the pad using Ctrl+Click
    await armPad(page, 0);

    // Verify the armed tracks panel appears
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();

    // Verify the track appears in the armed tracks panel
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileName);

    // Verify the pad has the armed indicator
    expect(await isPadArmed(page, 0)).toBe(true);
  });

  test("Armed track is visually indicated on the pad", async ({ page }) => {
    // Create and load an audio file to a pad
    const fileName = "visual-arm-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');

    // Load audio
    await padInput.setInputFiles(audioFilePath);

    // Verify pad is not armed initially (no star indicator)
    expect(await isPadArmed(page, 0)).toBe(false);

    // Arm the pad
    await armPad(page, 0);

    // Verify pad now shows armed indicator
    expect(await isPadArmed(page, 0)).toBe(true);
  });

  test("Can play an armed track using F9 key", async ({ page }) => {
    // Create and load an audio file to a pad
    const fileName = "f9-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(page.locator('[id^="pad-"]').first()).toContainText(fileName);

    // Arm the pad
    await armPad(page, 0);

    // Verify armed tracks panel shows our track
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileName);

    // Press F9 to play the armed track
    await page.keyboard.press("F9");

    // Verify the track is now playing
    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();

    // Verify the track is no longer in the armed tracks panel
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).not.toBeVisible();
  });

  test("Playing an armed track removes it from the armed tracks list", async ({
    page,
  }) => {
    // Setup two audio files
    const fileNames = ["test-arm-track1", "test-arm-track2"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add both audio files to pads
    const padInputs = [
      page.locator('[data-testid="pad-drop-input-0"]'),
      page.locator('[data-testid="pad-drop-input-1"]'),
    ];

    await padInputs[0].setInputFiles(filePaths[0]);
    await padInputs[1].setInputFiles(filePaths[1]);

    // Arm both pads
    await armPad(page, 0);
    await armPad(page, 1);

    // Verify both tracks are armed
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();
    let armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileNames[0]);
    expect(armedTrackNames).toContain(fileNames[1]);

    // Play the first armed track using its play button
    await clickPlayOnArmedTrack(page, fileNames[0]);

    // Verify first track is playing
    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText(fileNames[0])).toBeVisible();

    // Verify first track was removed from armed tracks but second is still there
    armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).not.toContain(fileNames[0]);
    expect(armedTrackNames).toContain(fileNames[1]);
  });

  test("Can remove an armed track without playing it", async ({ page }) => {
    // Create and load an audio file to a pad
    const fileName = "remove-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');

    // Load audio
    await padInput.setInputFiles(audioFilePath);
    await expect(page.locator('[id^="pad-"]').first()).toContainText(fileName);

    // Arm the pad
    await armPad(page, 0);

    // Verify track is armed
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileName);

    // Remove the track using the remove button
    await clickRemoveOnArmedTrack(page, fileName);

    // Verify the armed tracks panel is no longer visible (empty)
    await expect(armedPanel).not.toBeVisible();

    // Verify the track is not playing
    await expect(
      page.locator('[data-testid="active-tracks-panel"]').getByText(fileName),
    ).not.toBeVisible();
    await expect(page.locator("text=Nothing playing")).toBeVisible();
  });

  test("Can arm multiple tracks and play them in sequence", async ({
    page,
  }) => {
    // Setup three audio files
    const fileNames = ["queue-test1", "queue-test2", "queue-test3"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add all audio files to pads
    for (let i = 0; i < fileNames.length; i++) {
      const padInput = page.locator(`[data-testid="pad-drop-input-${i}"]`);
      await padInput.setInputFiles(filePaths[i]);
      await expect(page.locator(`[id^="pad-"][id$="-${i}"]`)).toContainText(
        fileNames[i],
      );
    }

    // Arm all pads in order
    for (let i = 0; i < fileNames.length; i++) {
      await armPad(page, i);
    }

    // Verify all tracks are armed in the correct order
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames.length).toBe(fileNames.length);
    expect(armedTrackNames[0]).toBe(fileNames[0]); // First armed track should be first in list

    // Play the first track using F9
    await page.keyboard.press("F9");

    // Verify the first track is playing and second is still armed
    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText(fileNames[0])).toBeVisible();
    let remainingArmedTracks = await getArmedTrackNames(page);
    expect(remainingArmedTracks).not.toContain(fileNames[0]);
    expect(remainingArmedTracks).toContain(fileNames[1]);

    // Play the second track using F9
    await page.keyboard.press("F9");

    // Verify the first and second tracks are playing, and third is still armed
    await expect(activeTracksPanel.getByText(fileNames[1])).toBeVisible();
    remainingArmedTracks = await getArmedTrackNames(page);
    expect(remainingArmedTracks).not.toContain(fileNames[0]);
    expect(remainingArmedTracks).not.toContain(fileNames[1]);
    expect(remainingArmedTracks).toContain(fileNames[2]);

    // Play the third track using F9
    await page.keyboard.press("F9");

    // Verify all tracks are playing and no armed tracks remain
    await expect(activeTracksPanel.getByText(fileNames[2])).toBeVisible();
    // Panel should no longer be visible as all tracks have been played
    await expect(armedPanel).not.toBeVisible();
  });

  test("Armed Tracks Panel appears when tracks are armed and disappears when empty", async ({
    page,
  }) => {
    // Initially panel should be hidden
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).not.toBeVisible();

    // Create and load an audio file to a pad
    const fileName = "panel-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    await padInput.setInputFiles(audioFilePath);

    // Arm the pad
    await armPad(page, 0);

    // Panel should now be visible
    await expect(armedPanel).toBeVisible();

    // Play the armed track
    await page.keyboard.press("F9");

    // Panel should disappear (empty)
    await expect(armedPanel).not.toBeVisible();

    // Arm the pad again
    await armPad(page, 0);

    // Panel should reappear
    await expect(armedPanel).toBeVisible();

    // Remove the track without playing it
    await clickRemoveOnArmedTrack(page, fileName);

    // Panel should disappear again
    await expect(armedPanel).not.toBeVisible();
  });

  test("Playing a pad directly doesnt affect armed status", async ({
    page,
  }) => {
    // Setup two audio files
    const fileNames = ["direct-play1", "direct-play2"];
    const filePaths = await createMultipleTestAudioFiles(fileNames);

    // Add both audio files to pads
    const padInputs = [
      page.locator('[data-testid="pad-drop-input-0"]'),
      page.locator('[data-testid="pad-drop-input-1"]'),
    ];
    const pads = [
      page.locator('[id^="pad-"]').nth(0),
      page.locator('[id^="pad-"]').nth(1),
    ];

    await padInputs[0].setInputFiles(filePaths[0]);
    await padInputs[1].setInputFiles(filePaths[1]);

    // Arm the first pad
    await armPad(page, 0);

    // Verify first track is armed
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileNames[0]);

    // Play the second pad directly
    await pads[1].click();

    // Verify second track is playing
    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText(fileNames[1])).toBeVisible();

    // Verify first track is still armed
    const updatedArmedTracks = await getArmedTrackNames(page);
    expect(updatedArmedTracks).toContain(fileNames[0]);

    // Now play the first pad directly
    await pads[0].click();

    // Verify first track is now playing
    await expect(activeTracksPanel.getByText(fileNames[0])).toBeVisible();

    // Verify first track is STILL armed (playing directly doesn't affect armed status)
    const finalArmedTracks = await getArmedTrackNames(page);
    expect(finalArmedTracks).toContain(fileNames[0]);
  });

  test("Can arm tracks from search results", async ({ page }) => {
    // This test requires that search functionality is working with Ctrl+Click to arm tracks

    // Setup an audio file
    const fileName = "search-arm-test";
    const audioFilePath = await createTestAudioFilePath(fileName);
    const padInput = page.locator('[data-testid="pad-drop-input-0"]');
    await padInput.setInputFiles(audioFilePath);

    // Wait for the track to be loaded
    await expect(page.locator('[id^="pad-"]').first()).toContainText(fileName);

    // Open search and arm the track from search results
    await armTrackFromSearch(page, fileName);

    // Verify track is armed
    const armedPanel = page.locator('[data-testid="armed-tracks-panel"]');
    await expect(armedPanel).toBeVisible();
    const armedTrackNames = await getArmedTrackNames(page);
    expect(armedTrackNames).toContain(fileName);

    // Play the armed track
    await page.keyboard.press("F9");

    // Verify track is playing
    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText(fileName)).toBeVisible();

    // Verify track is no longer armed
    await expect(armedPanel).not.toBeVisible();
  });
});

// ------ Armed tracks and the audio cache ------

test.describe("Armed tracks keep their sounds in the audio cache", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await prepareAudioContext(page);
  });

  /**
   * Loads a sound onto pad 0 and waits for the pad to show it.
   */
  async function loadSoundOnFirstPad(
    page: Page,
    fileName: string,
  ): Promise<void> {
    const audioFilePath = await createTestAudioFilePath(fileName);
    await page
      .locator('[data-testid="pad-drop-input-0"]')
      .setInputFiles(audioFilePath);
    // No per-assertion timeout: playwright.config.ts sets expect.timeout to
    // 15s precisely because 5000 — Playwright's old default written longhand —
    // left no headroom for decode + Blob into IndexedDB + re-render under
    // parallel load, and that is what made this suite flaky before.
    await expect(page.locator('[id^="pad-"]').first()).toContainText(fileName);
  }

  test("Arming a pad pins its sound and preloads it into the cache", async ({
    page,
  }) => {
    await loadSoundOnFirstPad(page, "pin-on-arm");

    // Nothing is armed yet, so nothing should be protected from eviction
    expect((await getAudioCacheState(page)).pinnedIds).toEqual([]);

    await armPad(page, 0);

    // The pin is taken as the track is armed; the decode that backs it may
    // land a moment later.
    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length, {
        timeout: 10000,
      })
      .toBe(1);

    await expect
      .poll(
        async () => {
          const { cachedIds, pinnedIds } = await getAudioCacheState(page);
          return pinnedIds.every((id) => cachedIds.includes(id));
        },
        { timeout: 10000 },
      )
      .toBe(true);
  });

  test("Firing an armed track plays the cached buffer and releases the pin", async ({
    page,
  }) => {
    // The instant trigger logs which path it took: a cached buffer plays
    // sample-accurately, anything else falls back to streaming or decoding.
    const consoleMessages: string[] = [];
    page.on("console", (message) => consoleMessages.push(message.text()));

    await loadSoundOnFirstPad(page, "cached-on-fire");
    await armPad(page, 0);

    // Wait until the armed sound is actually decoded before firing
    await expect
      .poll(
        async () => {
          const { cachedIds, pinnedIds } = await getAudioCacheState(page);
          return (
            pinnedIds.length === 1 &&
            pinnedIds.every((id) => cachedIds.includes(id))
          );
        },
        { timeout: 10000 },
      )
      .toBe(true);

    const { pinnedIds } = await getAudioCacheState(page);

    await page.keyboard.press("F9");

    const activeTracksPanel = page.locator(
      '[data-testid="active-tracks-panel"]',
    );
    await expect(activeTracksPanel.getByText("cached-on-fire")).toBeVisible();

    // The sound that played is the one that was pinned
    const activeSounds = await getActiveSounds(page);
    expect(activeSounds).toHaveLength(1);
    expect(pinnedIds).toContain(activeSounds[0].currentAudioFileId);

    // ...and it came from the cache, not from a load at trigger time
    expect(
      consoleMessages.some((text) =>
        text.includes(
          `[Audio Controls] [Instant] Playing cached buffer for ID: ${activeSounds[0].currentAudioFileId}`,
        ),
      ),
      `no cached-buffer playback logged; saw:\n${consoleMessages.join("\n")}`,
    ).toBe(true);

    // Firing the cue disarms it, which must release the pin
    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length)
      .toBe(0);
  });

  test("Removing an armed track releases its pin", async ({ page }) => {
    await loadSoundOnFirstPad(page, "unpin-on-remove");
    await armPad(page, 0);

    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length, {
        timeout: 10000,
      })
      .toBe(1);

    await clickRemoveOnArmedTrack(page, "unpin-on-remove");
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).not.toBeVisible();

    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length)
      .toBe(0);
  });

  test("Switching profiles disarms the cues of the profile left behind", async ({
    page,
  }) => {
    await loadSoundOnFirstPad(page, "cue-of-old-profile");
    await armPad(page, 0);
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).toBeVisible();
    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length, {
        timeout: 10000,
      })
      .toBe(1);

    await createAndSwitchToProfile(page, "Other Profile");

    // A cue belongs to the profile it was armed in: profiles are isolated, and
    // firing a pad from a profile that is no longer open would be a surprise.
    await expect(
      page.locator('[data-testid="armed-tracks-panel"]'),
    ).not.toBeVisible();
    expect(await getArmedTrackNames(page)).toEqual([]);

    // F9 must have nothing left to fire
    await page.keyboard.press("F9");
    await expect(page.getByText("Nothing playing")).toBeVisible();

    // ...and the sounds it was holding in memory are released
    await expect
      .poll(async () => (await getAudioCacheState(page)).pinnedIds.length)
      .toBe(0);
  });
});
