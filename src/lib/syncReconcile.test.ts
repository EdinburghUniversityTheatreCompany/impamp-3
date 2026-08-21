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
