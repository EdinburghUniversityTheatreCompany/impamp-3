import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/lib/db";

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

  it("leaves an email-invited editor alone", () => {
    // No share token, and on a profile predating serverRole they are
    // indistinguishable from an owner. Guessing here could strip a real
    // owner's folder, so this one waits for the user to decide.
    expect(
      hasBorrowedDriveLink(
        profile({ serverRole: "editor", googleDriveFolderId: "folder" }),
      ),
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
