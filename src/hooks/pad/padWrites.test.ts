/**
 * The tail every pad write shares.
 *
 * Both halves matter and neither is optional: the version bump is the only
 * invalidation signal the grid, the keyboard listener and the emergency set
 * have, and the sync request is what carries the write off this device. Six
 * call sites wrote them out by hand and two of those wrote only one of the
 * two, which is what these cases exist to keep from happening again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertPadConfiguration: vi.fn(async () => 7),
  incrementPadConfigsVersion: vi.fn(),
  requestSync: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  upsertPadConfiguration: mocks.upsertPadConfiguration,
}));
vi.mock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({
      incrementPadConfigsVersion: mocks.incrementPadConfigsVersion,
      requestSync: mocks.requestSync,
    }),
  },
}));

const { notifyPadConfigsChanged, savePadConfiguration } =
  await import("./padWrites");

const pad = {
  profileId: 3,
  bankId: "bank-uuid",
  padIndex: 5,
  audioFileIds: [11],
  playbackType: "sequential" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifyPadConfigsChanged", () => {
  it("bumps the shared version and asks sync to push the profile", () => {
    notifyPadConfigsChanged(3);

    expect(mocks.incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
    expect(mocks.requestSync).toHaveBeenCalledWith(3);
  });
});

describe("savePadConfiguration", () => {
  it("writes the pad, then announces it", async () => {
    await savePadConfiguration(pad);

    expect(mocks.upsertPadConfiguration).toHaveBeenCalledWith(pad);
    expect(mocks.incrementPadConfigsVersion).toHaveBeenCalledTimes(1);
    expect(mocks.requestSync).toHaveBeenCalledWith(3);
    // Order, not just occurrence: announcing a write that then failed would
    // have every reader re-read the unchanged row and call it the new truth.
    expect(
      mocks.upsertPadConfiguration.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.incrementPadConfigsVersion.mock.invocationCallOrder[0],
    );
  });

  it("announces nothing when the write throws", async () => {
    mocks.upsertPadConfiguration.mockRejectedValueOnce(new Error("quota"));

    await expect(savePadConfiguration(pad)).rejects.toThrow("quota");

    expect(mocks.incrementPadConfigsVersion).not.toHaveBeenCalled();
    expect(mocks.requestSync).not.toHaveBeenCalled();
  });
});
