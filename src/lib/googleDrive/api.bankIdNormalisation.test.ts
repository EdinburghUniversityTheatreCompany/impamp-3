/**
 * A pre-bankId blob gets repaired at the point it is parsed, not left for a
 * downstream consumer to trip on.
 *
 * `normaliseIncomingSyncData` (`@/lib/syncUtils`) mints a `bankId` for any
 * bank or pad that only carries a legacy `pageIndex`. Task 7 wired it into
 * `sync.ts`'s two pull sites, which have no test harness. `api.ts` sits one
 * layer below `sync.ts` and already has one (`api.timeouts.test.ts`), so the
 * fix lives at the two parse-and-return points here instead:
 * `downloadDriveFile` and `downloadPublicProfileData`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** A legacy pad: `pageIndex` on the pad itself, no `bankId` anywhere. */
const legacyPad = {
  profileId: 1,
  pageIndex: 2,
  padIndex: 0,
  name: "Horn",
  audioFileIds: [],
  playbackType: "sequential",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const legacyBlob = {
  _syncFormatVersion: 1,
  profile: { name: "Legacy", syncType: "googleDrive" },
  padConfigurations: [legacyPad],
  pageMetadata: [],
  audioFiles: [],
};

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: vi.fn(async () => {
    const text = JSON.stringify(legacyBlob);
    return {
      ok: true,
      status: 200,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }),
}));

const token = {
  accessToken: "token",
  expiresAt: Date.now() + 3_600_000,
} as never;
const noop = () => {};

beforeEach(() => {
  vi.resetModules();
});

describe("Drive blobs are repaired where they are parsed", () => {
  it("gives downloadDriveFile's pads a bankId minted from their pageIndex", async () => {
    const { downloadDriveFile } = await import("./api");

    const data = await downloadDriveFile("file-1", token, noop);

    expect(data?.padConfigurations).toHaveLength(1);
    expect(data?.padConfigurations[0]).toMatchObject({ bankId: "2" });
    // The migration also drops a pad's own copy of pageIndex.
    expect(data?.padConfigurations[0]).not.toHaveProperty("pageIndex");
  });

  it("gives downloadPublicProfileData's pads a bankId minted from their pageIndex", async () => {
    const { downloadPublicProfileData } = await import("./api");

    const data = await downloadPublicProfileData("file-1");

    expect(data?.padConfigurations).toHaveLength(1);
    expect(data?.padConfigurations[0]).toMatchObject({ bankId: "2" });
    expect(data?.padConfigurations[0]).not.toHaveProperty("pageIndex");
  });
});
