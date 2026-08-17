import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration } from "@/lib/db";

// Hoisted so `vi.mock`'s factories — which are lifted above the imports — can
// close over them without hitting the temporal dead zone.
const mocks = vi.hoisted(() => ({
  triggerPad: vi.fn(),
  pinAudioBuffer: vi.fn(),
  unpinAudioBuffer: vi.fn(),
  getPadConfigurationsForProfilePage: vi.fn(),
}));

vi.mock("@/lib/audio", () => ({ triggerPad: mocks.triggerPad }));
vi.mock("@/lib/audio/cache", () => ({
  pinAudioBuffer: mocks.pinAudioBuffer,
  unpinAudioBuffer: mocks.unpinAudioBuffer,
}));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getPadConfigurationsForProfilePage: mocks.getPadConfigurationsForProfilePage,
}));

import {
  playbackStoreActions,
  usePlaybackStore,
  type ArmedTrackState,
} from "@/store/playbackStore";

const ARMED_KEY = "armed-1-0-3";

// Everything the cue was armed with. Deliberately different in every field
// from what the pad is later given, so a test cannot pass by coincidence.
const ARMED_AS_SNAPSHOT: ArmedTrackState = {
  key: ARMED_KEY,
  name: "Doorbell",
  padInfo: { profileId: 1, pageIndex: 0, padIndex: 3 },
  audioFileIds: [10],
  playbackType: "sequential",
  audioTrimSettings: { 10: { trimStart: 0, trimEnd: 1 } },
  audioGainSettings: { 10: 3 },
  padGainDb: 0,
};

function padOnDisk(
  overrides: Partial<PadConfiguration> = {},
): PadConfiguration {
  return {
    profileId: 1,
    pageIndex: 0,
    padIndex: 3,
    name: "Doorbell",
    audioFileIds: [10],
    playbackType: "sequential",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PadConfiguration;
}

// The play path is three awaits deep (the pad read, the dynamic import of the
// audio module, the trigger itself); one macrotask drains all of them.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("armed cues play the pad as it is now", () => {
  beforeEach(() => {
    playbackStoreActions.clearAllArmedTracks();
    vi.clearAllMocks();
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([padOnDisk()]);
  });

  it("plays the sound the pad holds now, not the one it held when armed", async () => {
    // Arming took a full copy of the pad's playback definition, and no write
    // path ever re-synced it. Editing the pad after arming it left F9 firing
    // the pre-edit sound, at the pre-edit gain.
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([
      padOnDisk({
        name: "Thunder",
        audioFileIds: [20],
        playbackType: "round-robin",
        audioTrimSettings: { 20: { trimStart: 5, trimEnd: 9 } },
        audioGainSettings: { 20: -4 },
        padGainDb: -6,
      }),
    ]);

    playbackStoreActions.playNextArmedTrack();
    await settle();

    expect(mocks.triggerPad).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({
      padIndex: 3,
      name: "Thunder",
      audioFileIds: [20],
      playbackType: "round-robin",
      audioTrimSettings: { 20: { trimStart: 5, trimEnd: 9 } },
      audioGainSettings: { 20: -4 },
      padGainDb: -6,
    });
    expect(mocks.triggerPad.mock.calls[0][1]).toEqual({
      activeProfileId: 1,
      currentPageIndex: 0,
    });
  });

  it("fires nothing once the pad's sound has been removed", async () => {
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([
      padOnDisk({ audioFileIds: [], name: undefined }),
    ]);

    playbackStoreActions.playNextArmedTrack();
    await settle();

    expect(mocks.triggerPad).not.toHaveBeenCalled();
  });

  it("fires nothing when the pad has gone from the bank entirely", async () => {
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([]);

    playbackStoreActions.playNextArmedTrack();
    await settle();

    expect(mocks.triggerPad).not.toHaveBeenCalled();
  });

  it("carries the disabled flag through, so a pad disabled after arming stays silent", async () => {
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([
      padOnDisk({ isDisabled: true }),
    ]);

    playbackStoreActions.playNextArmedTrack();
    await settle();

    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({
      isDisabled: true,
    });
  });

  it("falls back to what was armed when the pad cannot be read", async () => {
    // A cue is a deliberate act during a show. A database that is momentarily
    // unreadable should not silence it — that is a different failure from the
    // pad having been emptied.
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    mocks.getPadConfigurationsForProfilePage.mockRejectedValue(
      new Error("IndexedDB is unavailable"),
    );

    playbackStoreActions.playNextArmedTrack();
    await settle();

    expect(mocks.triggerPad).toHaveBeenCalledTimes(1);
    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({
      audioFileIds: [10],
      padGainDb: 0,
    });
  });

  it("reads the cue's own pad when several are armed", async () => {
    playbackStoreActions.armTrack(ARMED_KEY, ARMED_AS_SNAPSHOT);
    playbackStoreActions.armTrack("armed-1-2-7", {
      ...ARMED_AS_SNAPSHOT,
      key: "armed-1-2-7",
      padInfo: { profileId: 1, pageIndex: 2, padIndex: 7 },
    });

    playbackStoreActions.playArmedTrack("armed-1-2-7");
    await settle();

    expect(mocks.getPadConfigurationsForProfilePage).toHaveBeenCalledWith(1, 2);
    // The head of the queue is untouched by playing a later cue.
    expect(usePlaybackStore.getState().armedTracks.has(ARMED_KEY)).toBe(true);
  });
});
