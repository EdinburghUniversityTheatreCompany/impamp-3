import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";
import { getSyncState } from "@/lib/syncState";

const dbMocks = vi.hoisted(() => ({
  getAllProfiles: vi.fn(),
  updateProfile: vi.fn(),
}));
vi.mock("@/lib/db", () => dbMocks);

const { hasBorrowedDriveLink, reconcileBorrowedDriveLinks } =
  await import("./syncReconcile");

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 1,
    name: "Test",
    syncType: "server",
    lastBackedUpAt: 0,
    backupReminderPeriod: 30,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const BORROWED = profile({
  id: 1,
  serverProfileId: "srv-1",
  serverShareToken: "tok",
  googleDriveFolderId: "their-folder",
});

describe("hasBorrowedDriveLink", () => {
  it("spots a link-imported profile holding the owner's folder", () => {
    expect(hasBorrowedDriveLink(BORROWED)).toBe(true);
  });

  it("spots one holding the owner's profile file", () => {
    expect(
      hasBorrowedDriveLink(
        profile({ serverShareToken: "tok", googleDriveFileId: "their-file" }),
      ),
    ).toBe(true);
  });

  it("leaves a link-imported profile with no Drive ids alone", () => {
    expect(hasBorrowedDriveLink(profile({ serverShareToken: "tok" }))).toBe(
      false,
    );
  });

  it("leaves the owner's own server profile alone", () => {
    expect(
      hasBorrowedDriveLink(
        profile({ serverRole: "owner", googleDriveFolderId: "my-folder" }),
      ),
    ).toBe(false);
  });

  it("spots an email-invited editor, who has no share token", () => {
    // The server said "editor", which is as provable as a share token, and it
    // is already what `ownsDriveFolder` refuses to publish on. Demanding a
    // token as well left this profile holding ids it can never write to — and
    // showing the banner for them forever, a defect with no fix button that
    // the code describes as cleared on load.
    expect(
      hasBorrowedDriveLink(
        profile({ serverRole: "editor", googleDriveFolderId: "folder" }),
      ),
    ).toBe(true);
  });

  it("spots a viewer the server marked read-only", () => {
    expect(
      hasBorrowedDriveLink(
        profile({ readOnly: true, googleDriveFolderId: "folder" }),
      ),
    ).toBe(true);
  });

  it("leaves a profile written before serverRole existed alone", () => {
    // No role, no token, not read-only: indistinguishable from an owner, and
    // guessing wrong strips a real owner's folder, so the next sync builds a
    // new one and re-uploads every sound into it. This is the case the token
    // requirement was protecting, and it still is.
    expect(
      hasBorrowedDriveLink(profile({ googleDriveFolderId: "folder" })),
    ).toBe(false);
  });

  it("leaves a plain Drive profile alone", () => {
    expect(
      hasBorrowedDriveLink(
        profile({
          syncType: "googleDrive",
          googleDriveFolderId: "my-folder",
          serverShareToken: "stale",
        }),
      ),
    ).toBe(false);
  });
});

describe("the sweep and the banner", () => {
  /**
   * They answer one question — "does this profile hold someone else's Drive
   * ids?" — and answered it with two rules. The banner's reads `ownership`,
   * which prefers the server's `serverRole` and only falls back to a share
   * token; the sweep's demanded a share token outright. So an email-invited
   * editor, or anyone the server marked read-only, was shown a defect that
   * `SyncDefectBanner` describes as "cleared on load" and which never was.
   */
  const cases: Array<[string, Profile]> = [
    ["a share-link recipient", BORROWED],
    [
      "an email-invited editor",
      profile({ serverRole: "editor", googleDriveFolderId: "folder" }),
    ],
    [
      "a read-only viewer",
      profile({ readOnly: true, googleDriveFolderId: "folder" }),
    ],
    [
      "an owner who opened their own share link",
      profile({
        serverRole: "owner",
        serverShareToken: "tok",
        googleDriveFolderId: "mine",
      }),
    ],
    [
      "a profile written before serverRole",
      profile({ googleDriveFolderId: "f" }),
    ],
    ["one with no Drive ids at all", profile({ serverShareToken: "tok" })],
    [
      "a Drive-synced profile",
      profile({ syncType: "googleDrive", googleDriveFolderId: "mine" }),
    ],
    ["a local profile", profile({ syncType: "local" })],
  ];

  it.each(cases)("agree about %s", (_name, p) => {
    expect(hasBorrowedDriveLink(p)).toBe(
      getSyncState(p).defects.includes("borrowed-drive-folder"),
    );
  });
});

describe("reconcileBorrowedDriveLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.updateProfile.mockResolvedValue(undefined);
  });

  it("clears both Drive ids and nothing else", () => {
    dbMocks.getAllProfiles.mockResolvedValue([BORROWED]);

    return reconcileBorrowedDriveLinks().then((count) => {
      expect(count).toBe(1);
      expect(dbMocks.updateProfile).toHaveBeenCalledWith(1, {
        googleDriveFileId: null,
        googleDriveFolderId: null,
      });
    });
  });

  it("touches nothing when there is nothing to repair", async () => {
    dbMocks.getAllProfiles.mockResolvedValue([
      profile({ serverRole: "owner", googleDriveFolderId: "mine" }),
      profile({ id: 2, syncType: "local" }),
    ]);

    expect(await reconcileBorrowedDriveLinks()).toBe(0);
    expect(dbMocks.updateProfile).not.toHaveBeenCalled();
  });

  it("repairs only the affected profiles in a mixed list", async () => {
    dbMocks.getAllProfiles.mockResolvedValue([
      profile({ id: 1, syncType: "local" }),
      BORROWED,
      profile({ id: 3, serverRole: "owner", googleDriveFolderId: "mine" }),
    ]);

    expect(await reconcileBorrowedDriveLinks()).toBe(1);
    expect(dbMocks.updateProfile).toHaveBeenCalledOnce();
    expect(dbMocks.updateProfile).toHaveBeenCalledWith(1, expect.anything());
  });

  it("finds nothing on a second run", async () => {
    dbMocks.getAllProfiles.mockResolvedValue([BORROWED]);
    await reconcileBorrowedDriveLinks();

    dbMocks.getAllProfiles.mockResolvedValue([
      profile({ id: 1, serverShareToken: "tok" }),
    ]);
    expect(await reconcileBorrowedDriveLinks()).toBe(0);
  });
});
