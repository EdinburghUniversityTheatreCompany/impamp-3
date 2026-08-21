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

  /**
   * Idempotence, against a store that remembers the first run.
   *
   * This used to hand the second call an already-repaired fixture by hand:
   * `updateProfile` is a mock, so the first call changed nothing, and the 0
   * came from a profile the test had rewritten itself. That is a restatement of
   * "leaves a link-imported profile with no Drive ids alone", three tests up,
   * dressed as idempotence — a repair that wrote the *wrong* fields would still
   * have found nothing on a second run.
   *
   * So the fake applies its patch and `getAllProfiles` reads it back. The
   * counts are then a real 1-then-0, and the state assertion is what catches a
   * repair that clears the wrong thing: clearing `serverShareToken` instead of
   * the Drive ids would also make the second run find nothing, because the
   * token is half of what `hasBorrowedDriveLink` looks for.
   *
   * It runs on every load, so "safe to run repeatedly" is the property that
   * matters most about it.
   */
  it("repairs once and then finds nothing, leaving its neighbours alone", async () => {
    const store: Profile[] = [
      profile({ id: 1, syncType: "local" }),
      { ...BORROWED, id: 2 },
      profile({ id: 3, serverRole: "owner", googleDriveFolderId: "mine" }),
    ];

    // Copies out, so the reconciler cannot mutate the store by holding a
    // reference to a row — the real `getAllProfiles` hands back fresh objects.
    dbMocks.getAllProfiles.mockImplementation(async () =>
      store.map((row) => ({ ...row })),
    );
    dbMocks.updateProfile.mockImplementation(
      async (id: number, patch: Partial<Profile>) => {
        const row = store.find((candidate) => candidate.id === id);
        if (!row) throw new Error(`updateProfile called with unknown id ${id}`);
        Object.assign(row, patch);
      },
    );

    expect(await reconcileBorrowedDriveLinks()).toBe(1);
    expect(await reconcileBorrowedDriveLinks()).toBe(0);

    expect(dbMocks.updateProfile).toHaveBeenCalledOnce();
    expect(store).toEqual([
      profile({ id: 1, syncType: "local" }),
      {
        ...BORROWED,
        id: 2,
        // The two ids that were never this device's, and nothing else: the
        // share token and the server profile it points at are still here.
        googleDriveFileId: null,
        googleDriveFolderId: null,
      },
      profile({ id: 3, serverRole: "owner", googleDriveFolderId: "mine" }),
    ]);
  });
});
