import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration, PageMetadata } from "@/lib/db";

const mocks = vi.hoisted(() => ({
  getAllPageMetadataForProfile: vi.fn(),
  getPadConfigurationsForProfilePage: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getAllPageMetadataForProfile: mocks.getAllPageMetadataForProfile,
  getPadConfigurationsForProfilePage: mocks.getPadConfigurationsForProfilePage,
}));

type EmergencySoundsModule = typeof import("@/hooks/emergencySounds");

// The set is module-global on purpose — it outlives every component that reads
// it — so each test gets its own copy of the module rather than a reset hook
// that would only exist for the tests.
async function freshModule(): Promise<EmergencySoundsModule> {
  vi.resetModules();
  return import("@/hooks/emergencySounds");
}

function page(profileId: number, pageIndex: number): PageMetadata {
  return {
    profileId,
    pageIndex,
    name: `Bank ${pageIndex + 1}`,
    isEmergency: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as PageMetadata;
}

function pad(pageIndex: number, padIndex: number): PadConfiguration {
  return {
    profileId: 0,
    pageIndex,
    padIndex,
    audioFileIds: [padIndex + 1],
    playbackType: "sequential",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as PadConfiguration;
}

describe("emergency sound loading", () => {
  beforeEach(() => {
    mocks.getAllPageMetadataForProfile.mockReset();
    mocks.getPadConfigurationsForProfilePage.mockReset();
    mocks.getPadConfigurationsForProfilePage.mockImplementation(
      (_profileId: number, pageIndex: number) =>
        Promise.resolve([pad(pageIndex, pageIndex)]),
    );
  });

  it("discards a superseded load, even when it resolves last", async () => {
    // Profile 1 has three emergency banks, profile 2 has one. A load is a
    // metadata read plus one pad read per emergency bank, so the profile you
    // switch *to* routinely finishes first — and profile 1's write then landed
    // last, leaving Enter firing the profile you had just left.
    const openMetadataReads = new Map<
      number,
      (pages: PageMetadata[]) => void
    >();
    mocks.getAllPageMetadataForProfile.mockImplementation(
      (profileId: number) =>
        new Promise((resolve) => openMetadataReads.set(profileId, resolve)),
    );

    const { reloadEmergencySounds, takeNextEmergencySound } =
      await freshModule();

    const leaving = reloadEmergencySounds(1);
    const arriving = reloadEmergencySounds(2);

    // The profile now on screen answers first...
    openMetadataReads.get(2)!([page(2, 0)]);
    await arriving;
    // ...and the one being left over answers afterwards.
    openMetadataReads.get(1)!([page(1, 0), page(1, 1), page(1, 2)]);
    await leaving;

    expect(takeNextEmergencySound()?.profileId).toBe(2);
  });

  it("discards a load for a profile that has since been cleared", async () => {
    let release: (pages: PageMetadata[]) => void = () => {};
    mocks.getAllPageMetadataForProfile.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );

    const { reloadEmergencySounds, emergencySoundCount } = await freshModule();

    const inFlight = reloadEmergencySounds(1);
    await reloadEmergencySounds(null);
    release([page(1, 0)]);
    await inFlight;

    expect(emergencySoundCount()).toBe(0);
  });

  it("loads every enabled, configured pad on every emergency bank", async () => {
    mocks.getAllPageMetadataForProfile.mockResolvedValue([
      page(1, 0),
      page(1, 3),
    ]);

    const { reloadEmergencySounds, emergencySoundCount } = await freshModule();
    await reloadEmergencySounds(1);

    expect(emergencySoundCount()).toBe(2);
  });

  it("skips disabled and empty pads", async () => {
    mocks.getAllPageMetadataForProfile.mockResolvedValue([page(1, 0)]);
    mocks.getPadConfigurationsForProfilePage.mockResolvedValue([
      { ...pad(0, 0), isDisabled: true },
      { ...pad(0, 1), audioFileIds: [] },
      pad(0, 2),
    ]);

    const { reloadEmergencySounds, takeNextEmergencySound } =
      await freshModule();
    await reloadEmergencySounds(1);

    expect(takeNextEmergencySound()?.padIndex).toBe(2);
  });

  it("cycles through the set in round-robin order and wraps", async () => {
    mocks.getAllPageMetadataForProfile.mockResolvedValue([
      page(1, 0),
      page(1, 1),
    ]);

    const { reloadEmergencySounds, takeNextEmergencySound } =
      await freshModule();
    await reloadEmergencySounds(1);

    expect(takeNextEmergencySound()?.pageIndex).toBe(0);
    expect(takeNextEmergencySound()?.pageIndex).toBe(1);
    expect(takeNextEmergencySound()?.pageIndex).toBe(0);
  });

  it("keeps the cursor when a reload finds the same pads", async () => {
    mocks.getAllPageMetadataForProfile.mockResolvedValue([
      page(1, 0),
      page(1, 1),
    ]);

    const { reloadEmergencySounds, takeNextEmergencySound } =
      await freshModule();
    await reloadEmergencySounds(1);
    takeNextEmergencySound(); // cursor now on the second sound

    await reloadEmergencySounds(1);

    expect(takeNextEmergencySound()?.pageIndex).toBe(1);
  });

  it("restarts the cursor when the set of pads actually changes", async () => {
    mocks.getAllPageMetadataForProfile.mockResolvedValue([
      page(1, 0),
      page(1, 1),
    ]);

    const { reloadEmergencySounds, takeNextEmergencySound } =
      await freshModule();
    await reloadEmergencySounds(1);
    takeNextEmergencySound();

    mocks.getAllPageMetadataForProfile.mockResolvedValue([
      page(1, 0),
      page(1, 1),
      page(1, 2),
    ]);
    await reloadEmergencySounds(1);

    expect(takeNextEmergencySound()?.pageIndex).toBe(0);
  });

  it("reports nothing to fire before anything has been loaded", async () => {
    const { hasLoadedEmergencySounds, takeNextEmergencySound } =
      await freshModule();

    expect(hasLoadedEmergencySounds()).toBe(false);
    expect(takeNextEmergencySound()).toBeUndefined();
  });
});
