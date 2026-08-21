import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "./db";
import { getUserByEmail, toPublicUser, upsertUserFromGoogle } from "./users";
import {
  createProfile,
  deleteProfile,
  getProfileById,
  listProfilesForUser,
  updateProfile,
} from "./profiles";
import { isSignupAllowed } from "./signupPolicy";
import {
  canWrite,
  createLinkShare,
  deleteShare,
  listShares,
  resolveAccess,
  upsertEmailShare,
} from "./shares";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb(); // opens a fresh in-memory database and runs migrations
});

const googleUser = (n: number) => ({
  sub: `google-sub-${n}`,
  email: `user${n}@example.com`,
  name: `User ${n}`,
  picture: null,
});

describe("users", () => {
  it("makes the first user an admin and later users unprivileged", () => {
    const first = upsertUserFromGoogle(googleUser(1));
    const second = upsertUserFromGoogle(googleUser(2));

    expect(first.is_admin).toBe(1);
    expect(second.is_admin).toBe(0);
    expect(second.can_upload_audio).toBe(0);
  });

  it("matches on google sub, so a changed email updates the same row", () => {
    const created = upsertUserFromGoogle(googleUser(1));
    const renamed = upsertUserFromGoogle({
      ...googleUser(1),
      email: "moved@example.com",
    });

    expect(renamed.id).toBe(created.id);
    expect(renamed.email).toBe("moved@example.com");
    expect(getUserByEmail("user1@example.com")).toBeUndefined();
  });

  it("folds email case so invites match regardless of how they were typed", () => {
    upsertUserFromGoogle({ ...googleUser(1), email: "MiXeD@Example.COM" });
    expect(getUserByEmail("mixed@example.com")?.email).toBe(
      "mixed@example.com",
    );
  });

  it("does not leak internal columns through the public shape", () => {
    const user = upsertUserFromGoogle(googleUser(1));
    expect(toPublicUser(user)).toEqual({
      id: user.id,
      email: "user1@example.com",
      name: "User 1",
      picture: null,
      isAdmin: true,
      canUploadAudio: false,
    });
  });
});

describe("profiles", () => {
  it("stores the sync blob and starts at version 1", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({
      ownerId: owner.id,
      name: "Panto",
      data: { padConfigurations: [{ padIndex: 0 }] },
    });

    expect(profile.version).toBe(1);
    // Read back rather than taken from the return value: an accepted write
    // reports what it decided (`ProfileMeta`) and does not hand the blob back,
    // so the row itself is the only thing that can say what was stored.
    expect(JSON.parse(getProfileById(profile.id)!.data)).toEqual({
      padConfigurations: [{ padIndex: 0 }],
    });
  });

  it("increments the version on each accepted write", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });

    const first = updateProfile(profile.id, {
      name: "P",
      data: { a: 1 },
      expectedVersion: 1,
    });
    expect(first.status).toBe("ok");
    expect(first.status === "ok" && first.profile.version).toBe(2);

    const second = updateProfile(profile.id, {
      name: "P",
      data: { a: 2 },
      expectedVersion: 2,
    });
    expect(second.status === "ok" && second.profile.version).toBe(3);
  });

  it("rejects a write from a stale version and returns the current row", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    updateProfile(profile.id, {
      name: "P",
      data: { winner: true },
      expectedVersion: 1,
    });

    // Second writer still thinks the profile is at version 1.
    const stale = updateProfile(profile.id, {
      name: "P",
      data: { loser: true },
      expectedVersion: 1,
    });

    expect(stale.status).toBe("conflict");
    expect(stale.status === "conflict" && stale.profile.version).toBe(2);
    // The losing write must not have landed.
    expect(JSON.parse(getProfileById(profile.id)!.data)).toEqual({
      winner: true,
    });
  });

  it("reports not_found for a profile that does not exist", () => {
    expect(
      updateProfile("nope", { name: "x", data: {}, expectedVersion: 1 }).status,
    ).toBe("not_found");
  });

  it("lists owned and email-shared profiles, but not link-shared ones", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const collaborator = upsertUserFromGoogle(googleUser(2));
    const stranger = upsertUserFromGoogle(googleUser(3));

    const owned = createProfile({ ownerId: owner.id, name: "Owned", data: {} });
    const shared = createProfile({
      ownerId: owner.id,
      name: "Shared",
      data: {},
    });
    const linked = createProfile({
      ownerId: owner.id,
      name: "Linked",
      data: {},
    });

    upsertEmailShare(shared.id, collaborator.email, "editor", owner.id);
    createLinkShare(linked.id, "viewer", owner.id);

    expect(
      listProfilesForUser(owner.id, owner.email)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["Linked", "Owned", "Shared"]);

    const forCollaborator = listProfilesForUser(
      collaborator.id,
      collaborator.email,
    );
    expect(forCollaborator).toHaveLength(1);
    expect(forCollaborator[0]).toMatchObject({
      id: shared.id,
      access: "editor",
      ownerEmail: owner.email,
    });

    expect(listProfilesForUser(stranger.id, stranger.email)).toEqual([]);
    expect(owned.id).not.toBe(shared.id);
  });

  it("cascades shares away when a profile is deleted", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    upsertEmailShare(profile.id, "friend@example.com", "viewer", owner.id);

    expect(deleteProfile(profile.id)).toBe(true);
    expect(listShares(profile.id)).toEqual([]);
  });
});

describe("access resolution", () => {
  it("grants the owner owner access", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });

    expect(resolveAccess({ profileId: profile.id, user: owner })).toBe("owner");
  });

  it("returns null for a user with no grant at all", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const stranger = upsertUserFromGoogle(googleUser(2));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });

    expect(resolveAccess({ profileId: profile.id, user: stranger })).toBeNull();
  });

  it("grants an invited email its share role", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const friend = upsertUserFromGoogle(googleUser(2));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    upsertEmailShare(profile.id, friend.email, "viewer", owner.id);

    expect(resolveAccess({ profileId: profile.id, user: friend })).toBe(
      "viewer",
    );
  });

  it("promotes an existing invite instead of duplicating it", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const friend = upsertUserFromGoogle(googleUser(2));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });

    upsertEmailShare(profile.id, friend.email, "viewer", owner.id);
    upsertEmailShare(profile.id, friend.email, "editor", owner.id);

    expect(listShares(profile.id)).toHaveLength(1);
    expect(resolveAccess({ profileId: profile.id, user: friend })).toBe(
      "editor",
    );
  });

  it("grants link-token access without any sign-in", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    const share = createLinkShare(profile.id, "viewer", owner.id);

    expect(
      resolveAccess({
        profileId: profile.id,
        user: null,
        linkToken: share.link_token,
      }),
    ).toBe("viewer");
  });

  it("refuses a link token minted for a different profile", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const target = createProfile({ ownerId: owner.id, name: "A", data: {} });
    const other = createProfile({ ownerId: owner.id, name: "B", data: {} });
    const share = createLinkShare(other.id, "editor", owner.id);

    expect(
      resolveAccess({
        profileId: target.id,
        user: null,
        linkToken: share.link_token,
      }),
    ).toBeNull();
  });

  it("keeps the strongest grant when several apply", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const friend = upsertUserFromGoogle(googleUser(2));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    upsertEmailShare(profile.id, friend.email, "viewer", owner.id);
    const editorLink = createLinkShare(profile.id, "editor", owner.id);

    // Viewer by invite, editor by link — the link wins.
    expect(
      resolveAccess({
        profileId: profile.id,
        user: friend,
        linkToken: editorLink.link_token,
      }),
    ).toBe("editor");

    // And a weaker link never demotes the owner.
    const viewerLink = createLinkShare(profile.id, "viewer", owner.id);
    expect(
      resolveAccess({
        profileId: profile.id,
        user: owner,
        linkToken: viewerLink.link_token,
      }),
    ).toBe("owner");
  });

  it("revokes access once a share is deleted", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const friend = upsertUserFromGoogle(googleUser(2));
    const profile = createProfile({ ownerId: owner.id, name: "P", data: {} });
    const share = upsertEmailShare(
      profile.id,
      friend.email,
      "editor",
      owner.id,
    );

    expect(deleteShare(profile.id, share.id)).toBe(true);
    expect(resolveAccess({ profileId: profile.id, user: friend })).toBeNull();
  });

  it("will not delete a share through a different profile's id", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    const a = createProfile({ ownerId: owner.id, name: "A", data: {} });
    const b = createProfile({ ownerId: owner.id, name: "B", data: {} });
    const share = upsertEmailShare(
      a.id,
      "friend@example.com",
      "editor",
      owner.id,
    );

    expect(deleteShare(b.id, share.id)).toBe(false);
    expect(listShares(a.id)).toHaveLength(1);
  });

  it("returns null for a profile that does not exist", () => {
    const owner = upsertUserFromGoogle(googleUser(1));
    expect(resolveAccess({ profileId: "missing", user: owner })).toBeNull();
  });

  it("treats only owner and editor as writable", () => {
    expect(canWrite("owner")).toBe(true);
    expect(canWrite("editor")).toBe(true);
    expect(canWrite("viewer")).toBe(false);
    expect(canWrite(null)).toBe(false);
  });
});

describe("signup policy", () => {
  const original = process.env.IMPAMP_ALLOWED_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.IMPAMP_ALLOWED_EMAILS;
    else process.env.IMPAMP_ALLOWED_EMAILS = original;
  });

  it("allows anyone when no policy is configured", () => {
    delete process.env.IMPAMP_ALLOWED_EMAILS;
    expect(isSignupAllowed("stranger@anywhere.com")).toBe(true);
  });

  it("allows a named address and refuses everyone else", () => {
    process.env.IMPAMP_ALLOWED_EMAILS = "me@example.com";
    expect(isSignupAllowed("me@example.com")).toBe(true);
    expect(isSignupAllowed("someone@example.com")).toBe(false);
  });

  it("allows a whole domain via an @suffix entry", () => {
    process.env.IMPAMP_ALLOWED_EMAILS = "@bedlamtheatre.co.uk";
    expect(isSignupAllowed("cast@bedlamtheatre.co.uk")).toBe(true);
    expect(isSignupAllowed("outsider@example.com")).toBe(false);
  });

  it("does not let a lookalike domain slip past a named address", () => {
    process.env.IMPAMP_ALLOWED_EMAILS = "me@example.com";
    expect(isSignupAllowed("me@example.com.evil.test")).toBe(false);
  });

  it("compares case- and whitespace-insensitively", () => {
    process.env.IMPAMP_ALLOWED_EMAILS = " Me@Example.COM , @Team.test ";
    expect(isSignupAllowed("me@example.com")).toBe(true);
    expect(isSignupAllowed("Someone@TEAM.test")).toBe(true);
  });
});
