import { Page, Locator, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Navigates to the app and waits until it is actually ready to be driven.
 *
 * Waiting for a pad element to exist is not enough, and is what made this
 * suite flaky under parallel load. The pad grid mounts before the active
 * profile resolves and before the bank tabs render, and anything done in that
 * window is dropped on the floor without an error:
 *
 *  - handleDropAudio() returns early while activeProfileId is null, so a file
 *    set on a pad's input never lands and the pad stays "Empty Pad";
 *  - the bank tabs are still absent, so counting them returns 0.
 *
 * Under one worker the gap closes before the first action; under ten it does
 * not, which is why these failures looked like CPU contention.
 */
export async function gotoApp(page: Page) {
  await page.goto("/");
  await waitForAppReady(page);
}

/**
 * Waits for a freshly loaded (or reloaded) app to be ready to drive.
 * See gotoApp for why each of these waits is needed.
 */
export async function waitForAppReady(page: Page) {
  await page.waitForSelector('[id^="pad-"]');

  // A real profile must be active before any pad write will persist.
  await page.waitForFunction(() => {
    const store = (
      window as unknown as {
        __profileStore?: { getState(): { activeProfileId: number | null } };
      }
    ).__profileStore;
    return !!store && store.getState().activeProfileId !== null;
  });

  // Bank tabs render from page metadata, loaded separately from the pads.
  await expect(page.locator('[role="tab"]').first()).toBeVisible();
}

/**
 * Holds Shift and waits for edit mode to actually engage.
 *
 * The keyboard listener detaches and re-attaches as app state changes, so the
 * delay between the keypress and edit mode turning on is not fixed. Waiting a
 * flat 200-300ms instead — as this suite used to — means the following click
 * sometimes lands in normal mode and plays the pad rather than opening the
 * edit modal.
 */
export async function enterEditMode(page: Page) {
  await page.keyboard.down("Shift");
  await expect(page.getByText("EDIT MODE", { exact: true })).toBeVisible();
}

/** Releases Shift and waits for edit mode to actually disengage. */
export async function exitEditMode(page: Page) {
  await page.keyboard.up("Shift");
  await expect(page.getByText("EDIT MODE", { exact: true })).toBeHidden();
}

/**
 * Helper function to create a test audio file path for testing.
 * Generates a simple sine wave audio buffer, formats it as WAV,
 * saves it to a temporary file, and returns the file path.
 */
export async function createTestAudioFilePath(
  fileName: string,
  // Most specs want a clip long enough to still be playing while they assert on
  // it. Pass something short when the file has to cross into the page (a 60s
  // mono WAV is ~5MB, and marshalling that through page.evaluate is slow enough
  // to blow the test timeout on its own).
  durationSeconds: number = 60,
): Promise<string> {
  // Generate raw audio data (simple sine wave)
  const sampleRate = 44100;
  const numChannels = 1; // Mono
  const numSamples = sampleRate * durationSeconds;
  const audioData = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    audioData[i] = Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 0.1; // A4 note
  }

  // Convert Float32Array to Int16Array for WAV format
  const int16Data = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    int16Data[i] = Math.max(-32768, Math.min(32767, audioData[i] * 32767));
  }

  // --- Create WAV Buffer ---
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const fileSize = 36 + dataSize; // 36 bytes for header before data chunk

  const buffer = Buffer.alloc(44 + dataSize); // 44 bytes for standard WAV header

  // RIFF chunk descriptor
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize, 4); // ChunkSize
  buffer.write("WAVE", 8);

  // "fmt " sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // "data" sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size

  // Write audio data
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(int16Data[i], 44 + i * 2);
  }
  // --- End WAV Buffer Creation ---

  // One directory per worker process, and the basename left alone.
  //
  // These used to go straight into os.tmpdir() under `${fileName}.wav`, which
  // is a fixed path shared by every worker: `Accordion_BassNote_01` belongs to
  // two specs that run concurrently at ten workers, each writing the file the
  // other is handing to `setInputFiles`. The contents are deterministic, so a
  // torn read is the only way it bites — and it bites as a decode failure or a
  // pad that stays empty, neither of which points anywhere near this line.
  //
  // The name, not the directory, is what a pad displays and what the specs
  // assert on, so the uniquifier has to go above it.
  const tempDir = path.join(
    os.tmpdir(),
    `impamp-e2e-${process.pid}-${process.env.TEST_WORKER_INDEX ?? "0"}`,
  );
  await fs.promises.mkdir(tempDir, { recursive: true });
  const tempFilePath = path.join(tempDir, fileName + ".wav");

  // Write the buffer to the temporary file
  await fs.promises.writeFile(tempFilePath, buffer);

  console.log(`Created temporary test audio file: ${tempFilePath}`);
  return tempFilePath;
}

/**
 * Helper function to create multiple test audio files.
 * Calls createTestAudioFilePath for each name in the provided array.
 */
export async function createMultipleTestAudioFiles(
  fileNames: string[],
): Promise<string[]> {
  const filePaths: string[] = [];
  for (const fileName of fileNames) {
    const filePath = await createTestAudioFilePath(fileName);
    filePaths.push(filePath);
  }
  console.log(`Created ${filePaths.length} temporary test audio files.`);
  return filePaths;
}

/**
 * Helper function to activate a pad (tries both click and keyboard)
 * and verify it's playing
 */
export async function activatePad(
  page: Page,
  padLocator: Locator,
  keyBinding?: string,
) {
  console.log("Activating pad...");

  // There used to be a `page.evaluate` here headed "First, ensure AudioContext
  // is resumed", which walked `window._audioContextInstances` and resumed
  // every suspended context in it. No such property exists: nothing in `src/`
  // writes it, so the list was always `[]` and the step always resumed
  // nothing. It read as the thing standing between this helper and the browser
  // autoplay policy, and it was a round trip to the page and back for an empty
  // loop. What actually unlocks the context is the click or keypress below,
  // through `ensureAudioContextActive` in the app's own handlers.

  const activate = async () => {
    if (keyBinding) {
      console.log(`Pressing key: ${keyBinding}`);
      await page.keyboard.press(keyBinding);
    } else {
      console.log("Clicking pad");
      await padLocator.click({ force: true });
    }
  };

  const nothingPlaying = page.locator("text=Nothing playing");

  // Activate until something plays, rather than once and then wait.
  //
  // One press is not guaranteed delivery, and this was the whole of the
  // "activatePad fails with playback never starting within 30 s" flake. The
  // keyboard listener reads its pad configurations through
  // `actionablePadConfigs`, which deliberately hands back an EMPTY map while a
  // read is in flight — otherwise a key pressed just after a bank switch plays
  // the previous bank's pad, which is far worse on a live board than a key
  // that does nothing. Assigning a sound starts such a read, and the pad's
  // *label* comes from the read that already settled, so a spec that waits for
  // the name and then presses the key can land inside the next read's window.
  // The page log at the moment of failure says so in as many words:
  //
  //     [KeyboardListener] Key q maps to default pad index: 0
  //     [KeyboardListener] No configuration found for default pad index: 0
  //
  // and the press after it works. Nothing observable distinguishes "the read
  // is in flight" from outside the app, so the honest fix here is to re-issue
  // the activation rather than to wait longer for a press that was dropped.
  //
  // This cannot hide a broken key: every attempt would be dropped and the
  // whole poll would fail. The intervals are generous so that a press which
  // did land is given time to produce a sound before another is sent — with
  // the default `continue` retrigger behaviour a second press on a playing pad
  // is a documented no-op, but a pad configured to `stop` or `restart` would
  // notice, so this helper stays for freshly-assigned default pads.
  await expect
    .poll(
      async () => {
        if (await nothingPlaying.isHidden()) return true;
        await activate();
        return nothingPlaying.isHidden();
      },
      {
        timeout: 30000,
        intervals: [2000, 2000, 3000, 5000],
        message: "the pad should have started playing",
      },
    )
    .toBe(true);

  // Look for the progress bar on the pad
  const progressBar = padLocator.locator(".bg-green-500");
  await expect(progressBar).toBeVisible();

  console.log("Pad playing verified");
}

/**
 * Utility to prepare the audio context for testing
 * This ensures createBuffer returns non-silent buffers
 */
export async function prepareAudioContext(page: Page) {
  await page.evaluate(() => {
    // Create a mock for the AudioContext.createBuffer to return a valid buffer
    const originalCreateBuffer = AudioContext.prototype.createBuffer;
    AudioContext.prototype.createBuffer = function (
      numChannels,
      length,
      sampleRate,
    ) {
      const buffer = originalCreateBuffer.call(
        this,
        numChannels,
        length,
        sampleRate,
      );
      // Fill with some data so it's not silent
      const channelData = buffer.getChannelData(0);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.sin(i / 100) * 0.5;
      }
      return buffer;
    };
  });
}

/**
 * A currently-playing track, as reported by the __impampActiveSounds test hook.
 */
export interface ActiveSoundInfo {
  key: string;
  /** The pad's own playback key — equal to `key` unless this is a layer. */
  baseKey?: string;
  /** 0 for a pad's un-layered instance, otherwise the layer's number. */
  layerIndex?: number;
  name: string;
  /** Which pipeline is playing: a decoded buffer or a streamed media element. */
  sourceKind?: string;
  playbackType?: string;
  currentAudioFileId?: number;
  currentAudioIndex?: number;
  allAudioFileIds?: number[];
}

/**
 * Reads the audio module's live track list.
 *
 * Which sound a multi-sound pad selected is deliberately invisible in the UI —
 * the Active Tracks panel shows the pad's name — so tests that care about
 * selection order read it through the hook src/lib/testHooks.ts installs.
 */
export async function getActiveSounds(page: Page): Promise<ActiveSoundInfo[]> {
  return page.evaluate(() => {
    const read = (
      window as unknown as {
        __impampActiveSounds?: () => ActiveSoundInfo[];
      }
    ).__impampActiveSounds;
    if (typeof read !== "function") {
      throw new Error(
        "__impampActiveSounds hook is missing — the server under test must be " +
          "built with NEXT_PUBLIC_E2E_HOOKS=1 (playwright.config.ts sets it).",
      );
    }
    return read();
  }) as Promise<ActiveSoundInfo[]>;
}

/**
 * Creates a second local profile through the profile manager and switches to
 * it, leaving the app on the new (empty) profile.
 */
export async function createAndSwitchToProfile(
  page: Page,
  name: string,
): Promise<void> {
  const profileSelector = page.getByRole("button", { name: /^Profile: / });
  await profileSelector.click();
  await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
  await expect(page.getByText(/Profile Manager/i)).toBeVisible();

  await page.getByRole("textbox", { name: "Profile Name" }).fill(name);
  await page.getByRole("button", { name: /Create Profile/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await page.getByLabel("Close").click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeHidden();

  await profileSelector.click();
  await page.getByRole("menuitem", { name }).click();
  await expect(profileSelector).toContainText(name);
}

/**
 * What the audio buffer cache is holding, as reported by the
 * __impampAudioCache test hook.
 */
export interface AudioCacheState {
  /** Audio file IDs with a decoded buffer (or a failed-decode marker) */
  cachedIds: number[];
  /** Audio file IDs protected from LRU eviction, e.g. by an armed track */
  pinnedIds: number[];
}

/**
 * Reads which sounds are decoded and which are pinned against eviction.
 *
 * Neither is visible in the UI, so the armed-track cache tests read them
 * through the hook src/lib/audio/cache.ts installs.
 */
export async function getAudioCacheState(page: Page): Promise<AudioCacheState> {
  return page.evaluate(() => {
    const read = (
      window as unknown as {
        __impampAudioCache?: () => AudioCacheState;
      }
    ).__impampAudioCache;
    if (typeof read !== "function") {
      throw new Error(
        "__impampAudioCache hook is missing — the server under test must be " +
          "built with NEXT_PUBLIC_E2E_HOOKS=1 (playwright.config.ts sets it).",
      );
    }
    return read();
  }) as Promise<AudioCacheState>;
}

/**
 * Index, within the pad's own sound list, of the sound currently playing.
 * Asserts exactly one track is active so a stray track can't be read silently.
 */
async function getPlayingSoundIndex(page: Page): Promise<number> {
  const active = await getActiveSounds(page);
  expect(active).toHaveLength(1);
  const index = active[0].currentAudioIndex;
  expect(
    index,
    "active track carries no currentAudioIndex",
  ).not.toBeUndefined();
  return index as number;
}

/**
 * Stops the single playing track by clicking its entry in the Active Tracks
 * panel, and waits for the panel to fall back to "Nothing playing".
 *
 * Multi-sound pads need this between triggers: the default activePadBehavior is
 * "continue", so re-triggering a pad that is already playing is a no-op and the
 * playback strategy never advances.
 */
async function stopPlayingTrack(page: Page) {
  await page.locator('[data-testid="active-track-item"]').first().click();
  await expect(page.locator("text=Nothing playing")).toBeVisible();
}

/**
 * Triggers a pad, waits for playback to register, reads which sound the
 * playback strategy picked, then stops it again. Returns the sound's index.
 */
export async function triggerAndReadSoundIndex(
  page: Page,
  pad: Locator,
): Promise<number> {
  await pad.click();
  await expect(page.locator('[data-testid="active-track-item"]')).toHaveCount(
    1,
  );
  const index = await getPlayingSoundIndex(page);
  await stopPlayingTrack(page);
  return index;
}

/**
 * Sets the *profile's* "what happens when a pad is triggered while it plays"
 * through the Playback Settings modal.
 *
 * This is the profile default, not a per-pad override: a pad that has never
 * been given a behaviour of its own follows whatever is set here. The pad's
 * own override lives in the Edit Pad modal, under the
 * `edit-pad-active-behavior-*` test ids.
 *
 * Lives here rather than in one spec because two specs now need it — the
 * behaviour tests in audio-playback.spec.ts and the layering tests in
 * layered-retrigger.spec.ts — and a second copy of a form-driving helper is
 * exactly how the two drift apart.
 */
export async function setProfileActivePadBehavior(
  page: Page,
  behavior: string,
) {
  const settingsButton = page.locator(
    '[data-testid="active-tracks-panel"] button[aria-label="Playback settings"]',
  );
  await settingsButton.click();

  const modal = page.locator(".fixed.inset-0.bg-black\\/50");
  await expect(modal).toBeVisible();

  const behaviorRadioButton = modal.locator(
    `input[name="activePadBehavior"][value="${behavior}"]`,
  );
  await expect(behaviorRadioButton).toBeVisible();
  await behaviorRadioButton.click();

  const saveButton = modal.locator('button:has-text("Save Settings")');
  await saveButton.click();

  await expect(modal).not.toBeVisible(); // Wait for modal to close
  console.log(`[Test Helper] Set profile activePadBehavior to: ${behavior}`);
}

// --- Helpers for Edit Pad Modal ---

// Helper to open the edit modal for a specific pad
export async function openEditPadModal(page: Page, padIndex: number) {
  await enterEditMode(page);
  await page.locator(`[id^="pad-"][id$="-${padIndex}"]`).click(); // Click the specific pad
  await expect(page.locator('[data-testid="custom-modal"]')).toBeVisible();
  await expect(page.locator('[data-testid="modal-title"]')).toContainText(
    "Edit Pad",
  );
  console.log(`[Test Helper] Opened edit modal for pad index ${padIndex}`);
}

// Helper to add sounds via the modal's file input
export async function addSoundsToPadModal(page: Page, filePaths: string[]) {
  const fileInput = page.locator("#addSoundsInput"); // Use the ID we added
  await fileInput.setInputFiles(filePaths);
  // Wait for sounds to potentially appear in the list
  await page.waitForSelector(`[data-testid^="edit-pad-sound-item-"]`);
  console.log(`[Test Helper] Added ${filePaths.length} sounds via modal`);
}

// Helper to set playback mode in the modal
// Note: Requires PlaybackType to be imported in the test file using this helper
export async function setPlaybackModeInModal(page: Page, mode: string) {
  // Use string here, rely on caller for type
  await page.locator(`[data-testid="edit-pad-playback-mode-${mode}"]`).click();
  console.log(`[Test Helper] Set playback mode to ${mode} in modal`);
}

// Helper to tick / untick the "Pad active" checkbox in the edit modal.
// Ticked means the pad is active; unticked means it is disabled and will not
// play from any trigger (click, key, armed cue, emergency, search).
export async function setPadActiveInModal(page: Page, active: boolean) {
  const checkbox = page.locator('[data-testid="edit-pad-active-checkbox"]');
  await expect(checkbox).toBeVisible();
  if (active) {
    await checkbox.check();
  } else {
    await checkbox.uncheck();
  }
  console.log(`[Test Helper] Set pad active=${active} in modal`);
}

// Asserts that no audio is currently playing.
export async function expectNothingPlaying(page: Page) {
  await expect(page.locator("text=Nothing playing")).toBeVisible();
}

// Helper to remove a specific sound from the modal list
export async function removeSoundFromModal(page: Page, soundName: string) {
  // Locate the remove button by its aria-label, which is built from the sound's
  // stored name — that keeps the file extension ("soundToRemove.wav") while
  // callers pass the bare name, so match on the prefix rather than exactly.
  const removeButton = page.locator(
    `button[aria-label^="Remove ${soundName}"]`,
  );
  await expect(removeButton).toBeVisible();
  await removeButton.click();
  console.log(`[Test Helper] Clicked remove for sound "${soundName}" in modal`);
  // Verify the button (and thus the list item) is gone
  await expect(removeButton).not.toBeVisible();
}

// --- Helper for Bank Creation ---

// Enters edit mode, clicks "Add new bank", confirms the default name in the
// resulting modal, and waits for the new tab to appear. Returns the bank
// count *before* the new bank was added. Leaves Shift held down.
export async function createNewBankViaUi(page: Page): Promise<number> {
  await enterEditMode(page);

  const addBankButton = page.getByRole("button", { name: "Add new bank" });
  await expect(addBankButton).toBeVisible();

  // The "Add new bank" button appears with edit mode, but the tabs beside it
  // render from the profile's bank names, which load separately. count() is
  // the one locator call that does *not* auto-wait, so reading it in that gap
  // silently returns 0 — and then every expectation below is off by the real
  // bank count ("Bank 1" vs the app's "Bank 11"). Wait for the tabs first.
  const bankTabs = page.locator('[role="tab"]');
  await expect(bankTabs.first()).toBeVisible();
  const initialBanks = await bankTabs.count();

  await addBankButton.click();

  await page.waitForSelector('[data-testid="custom-modal"]');
  await expect(page.locator('[data-testid="modal-title"]')).toContainText(
    "Add New Bank",
  );

  const addInput = page.locator('[data-testid="prompt-input"]');
  await expect(addInput).toHaveValue(`Bank ${initialBanks + 1}`); // Assumes banks are 1-indexed

  await page.locator('[data-testid="modal-confirm-button"]').click();

  await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
  await expect(page.locator('[role="tab"]')).toHaveCount(initialBanks + 1);

  return initialBanks;
}

// Helper to save changes in the edit modal
export async function savePadEditModal(page: Page) {
  await page.locator('[data-testid="modal-confirm-button"]').click();
  await expect(page.locator('[data-testid="custom-modal"]')).toBeHidden();
  console.log(`[Test Helper] Saved pad edit modal`);
  await exitEditMode(page);
}

// --- Profile sync state -----------------------------------------------------
//
// Sync state is a combination of stored fields, and most of the interesting
// combinations cannot be reached by clicking: they need a Google account, a
// server share link, or a profile that predates a field. The store exposes
// itself as `window.__profileStore` under NEXT_PUBLIC_E2E_HOOKS (set by
// e2e-tests/env.js), so a spec can seed a state directly and assert on what the
// app makes of it.

type ProfileSyncFields = Record<string, unknown>;

interface ProfileStoreHook {
  getState(): {
    activeProfileId: number | null;
    updateProfile(id: number, updates: unknown): Promise<void>;
    fetchProfiles(): Promise<unknown>;
    profiles: Array<Record<string, unknown>>;
  };
}

/** Write sync bookkeeping straight onto the active profile. */
export async function seedActiveProfileSync(
  page: Page,
  fields: ProfileSyncFields,
) {
  await page.evaluate(async (patch) => {
    const store = (window as unknown as { __profileStore: ProfileStoreHook })
      .__profileStore;
    const { activeProfileId, updateProfile } = store.getState();
    await updateProfile(activeProfileId!, patch);
  }, fields);
}

/** Read the active profile back out of the store, refreshing it from the DB. */
export async function readActiveProfile(
  page: Page,
): Promise<ProfileSyncFields> {
  return page.evaluate(async () => {
    const store = (window as unknown as { __profileStore: ProfileStoreHook })
      .__profileStore;
    await store.getState().fetchProfiles();
    const { activeProfileId, profiles } = store.getState();
    return profiles.find((p) => p.id === activeProfileId) as ProfileSyncFields;
  });
}

/**
 * Open the Profile Manager through the header, as a user would.
 *
 * Every locator here auto-waits and nothing is guarded, which is the point.
 * This used to open with `getByRole("button", {name: /Profile/i}).first()` —
 * a regex that also matches "Edit Profile", "Create Profile" and "Use This
 * Profile" inside an already-open manager — and then
 * `if (await manage.count()) await manage.click()`. `count()` does not
 * auto-wait and the dropdown renders on a React state update after `click()`
 * resolves, so under load a zero count turned "the menu had not painted yet"
 * into "silently skip opening the manager". Callers assert afterwards, so it
 * failed red rather than green, but on `sync-status-chip not found` rather
 * than on the real cause.
 */
export async function openProfileManager(page: Page) {
  await page.getByRole("button", { name: /^Profile: / }).click();
  await page.getByRole("menuitem", { name: "Manage Profiles" }).click();
  await expect(
    page.getByRole("heading", { name: "Profile Manager" }),
  ).toBeVisible();
}
