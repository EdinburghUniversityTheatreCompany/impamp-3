/**
 * Integration tests for the server-sync API, driving the real route handlers
 * against a real (in-memory) database.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/server/db";
import { createSession } from "@/lib/server/session";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { createProfile } from "@/lib/server/profiles";
import { createLinkShare, upsertEmailShare } from "@/lib/server/shares";
import {
  makeApiRequest as makeRequest,
  routeParams,
  type ApiRequestOptions,
} from "@/lib/server/testSupport";

import { GET as listProfiles, POST as postProfile } from "./route";
import {
  DELETE as deleteProfileRoute,
  GET as getProfile,
  PUT as putProfile,
} from "./[id]/route";
import { GET as listShares, POST as postShare } from "./[id]/shares/route";
import { DELETE as deleteShareRoute } from "./[id]/shares/[shareId]/route";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const signIn = (n: number) => {
  const user = upsertUserFromGoogle({
    sub: `sub-${n}`,
    email: `user${n}@example.com`,
    name: `User ${n}`,
    picture: null,
  });
  return { user, token: createSession(user.id) };
};

const sampleData = { _syncFormatVersion: 1, padConfigurations: [] };

type SignedIn = ReturnType<typeof signIn>;

const ownedProfile = (owner: SignedIn, name = "Panto") =>
  createProfile({ ownerId: owner.user.id, name, data: sampleData });

/** An owner, a profile, and a second user with editor access to it. */
function profileWithEditor() {
  const owner = signIn(1);
  const editor = signIn(2);
  const profile = ownedProfile(owner);
  upsertEmailShare(profile.id, editor.user.email, "editor", owner.user.id);
  return { owner, editor, profile };
}

describe("GET /api/profiles", () => {
  it("refuses an anonymous caller", async () => {
    const response = await listProfiles(makeRequest("/api/profiles"));
    expect(response.status).toBe(401);
  });

  it("lists owned and shared profiles", async () => {
    const owner = signIn(1);
    const friend = signIn(2);
    const profile = ownedProfile(owner);
    upsertEmailShare(profile.id, friend.user.email, "editor", owner.user.id);

    const response = await listProfiles(
      makeRequest("/api/profiles", { sessionToken: friend.token }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({ name: "Panto", access: "editor" });
  });
});

describe("POST /api/profiles", () => {
  it("creates a profile at version 1 owned by the caller", async () => {
    const owner = signIn(1);
    const response = await postProfile(
      makeRequest("/api/profiles", {
        method: "POST",
        sessionToken: owner.token,
        body: { name: "New Show", data: sampleData },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      name: "New Show",
      version: 1,
      access: "owner",
    });
    expect(response.headers.get("etag")).toBe('"1"');
  });

  it("rejects a missing name or non-object data", async () => {
    const owner = signIn(1);

    const noName = await postProfile(
      makeRequest("/api/profiles", {
        method: "POST",
        sessionToken: owner.token,
        body: { name: "   ", data: sampleData },
      }),
    );
    expect(noName.status).toBe(400);

    const badData = await postProfile(
      makeRequest("/api/profiles", {
        method: "POST",
        sessionToken: owner.token,
        body: { name: "X", data: "not an object" },
      }),
    );
    expect(badData.status).toBe(400);
  });
});

describe("GET /api/profiles/:id", () => {
  it("returns the blob with the version as an ETag", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await getProfile(
      makeRequest(`/api/profiles/${profile.id}`, { sessionToken: owner.token }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(body.data).toEqual(sampleData);
    expect(body.access).toBe("owner");
  });

  it("answers 304 when the caller already has the current version", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await getProfile(
      makeRequest(`/api/profiles/${profile.id}`, {
        sessionToken: owner.token,
        headers: { "if-none-match": '"1"' },
      }),
      routeParams({ id: profile.id }),
    );

    expect(response.status).toBe(304);
  });

  it("hides a profile the caller has no grant on, as 404 not 403", async () => {
    const owner = signIn(1);
    const stranger = signIn(2);
    const profile = ownedProfile(owner);

    const response = await getProfile(
      makeRequest(`/api/profiles/${profile.id}`, {
        sessionToken: stranger.token,
      }),
      routeParams({ id: profile.id }),
    );

    expect(response.status).toBe(404);
  });

  it("serves an anonymous caller holding a share link", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);
    const share = createLinkShare(profile.id, "viewer", owner.user.id);

    const response = await getProfile(
      makeRequest(`/api/profiles/${profile.id}`, {
        query: `token=${share.link_token}`,
      }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.access).toBe("viewer");
  });
});

describe("PUT /api/profiles/:id", () => {
  const putRequest = (
    id: string,
    token: string | undefined,
    version: string | null,
    data: unknown,
    extra: ApiRequestOptions = {},
  ) =>
    makeRequest(`/api/profiles/${id}`, {
      method: "PUT",
      sessionToken: token,
      headers: version === null ? {} : { "if-match": version },
      body: { name: "Panto", data },
      ...extra,
    });

  it("accepts a write from the current version and bumps it", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await putProfile(
      putRequest(profile.id, owner.token, '"1"', { updated: true }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.version).toBe(2);
    expect(response.headers.get("etag")).toBe('"2"');
  });

  it("requires If-Match so a blind write can't clobber", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await putProfile(
      putRequest(profile.id, owner.token, null, { updated: true }),
      routeParams({ id: profile.id }),
    );

    expect(response.status).toBe(428);
  });

  it("returns 409 with the current blob when the version is stale", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);
    await putProfile(
      putRequest(profile.id, owner.token, '"1"', { first: true }),
      routeParams({ id: profile.id }),
    );

    // Second writer is still on version 1.
    const response = await putProfile(
      putRequest(profile.id, owner.token, '"1"', { second: true }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.version).toBe(2);
    // The 409 carries the winning data, so the client can merge without
    // another round trip.
    expect(body.data).toEqual({ first: true });
  });

  it("refuses a viewer and allows an editor", async () => {
    const owner = signIn(1);
    const viewer = signIn(2);
    const editor = signIn(3);
    const profile = ownedProfile(owner);
    upsertEmailShare(profile.id, viewer.user.email, "viewer", owner.user.id);
    upsertEmailShare(profile.id, editor.user.email, "editor", owner.user.id);

    const refused = await putProfile(
      putRequest(profile.id, viewer.token, '"1"', { x: 1 }),
      routeParams({ id: profile.id }),
    );
    expect(refused.status).toBe(403);

    const allowed = await putProfile(
      putRequest(profile.id, editor.token, '"1"', { x: 1 }),
      routeParams({ id: profile.id }),
    );
    expect(allowed.status).toBe(200);
  });

  it("accepts a weak or unquoted If-Match value", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const weak = await putProfile(
      putRequest(profile.id, owner.token, 'W/"1"', { a: 1 }),
      routeParams({ id: profile.id }),
    );
    expect(weak.status).toBe(200);

    const bare = await putProfile(
      putRequest(profile.id, owner.token, "2", { a: 2 }),
      routeParams({ id: profile.id }),
    );
    expect(bare.status).toBe(200);
  });
});

describe("DELETE /api/profiles/:id", () => {
  it("lets the owner delete but not an editor", async () => {
    const { owner, editor, profile } = profileWithEditor();

    const refused = await deleteProfileRoute(
      makeRequest(`/api/profiles/${profile.id}`, {
        method: "DELETE",
        sessionToken: editor.token,
      }),
      routeParams({ id: profile.id }),
    );
    expect(refused.status).toBe(403);

    const allowed = await deleteProfileRoute(
      makeRequest(`/api/profiles/${profile.id}`, {
        method: "DELETE",
        sessionToken: owner.token,
      }),
      routeParams({ id: profile.id }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("share management", () => {
  it("is owner-only for listing", async () => {
    const { owner, editor, profile } = profileWithEditor();

    const refused = await listShares(
      makeRequest(`/api/profiles/${profile.id}/shares`, {
        sessionToken: editor.token,
      }),
      routeParams({ id: profile.id }),
    );
    expect(refused.status).toBe(403);

    const allowed = await listShares(
      makeRequest(`/api/profiles/${profile.id}/shares`, {
        sessionToken: owner.token,
      }),
      routeParams({ id: profile.id }),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).shares).toHaveLength(1);
  });

  it("mints a link share when no email is given", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await postShare(
      makeRequest(`/api/profiles/${profile.id}/shares`, {
        method: "POST",
        sessionToken: owner.token,
        body: { role: "viewer" },
      }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.share.linkToken).toBeTruthy();
    expect(body.share.email).toBeNull();
  });

  it("rejects an unknown role", async () => {
    const owner = signIn(1);
    const profile = ownedProfile(owner);

    const response = await postShare(
      makeRequest(`/api/profiles/${profile.id}/shares`, {
        method: "POST",
        sessionToken: owner.token,
        body: { role: "admin" },
      }),
      routeParams({ id: profile.id }),
    );
    expect(response.status).toBe(400);
  });

  it("revokes a share, and access with it", async () => {
    const owner = signIn(1);
    const friend = signIn(2);
    const profile = ownedProfile(owner);
    const share = upsertEmailShare(
      profile.id,
      friend.user.email,
      "editor",
      owner.user.id,
    );

    const revoked = await deleteShareRoute(
      makeRequest(`/api/profiles/${profile.id}/shares/${share.id}`, {
        method: "DELETE",
        sessionToken: owner.token,
      }),
      routeParams({ id: profile.id, shareId: String(share.id) }),
    );
    expect(revoked.status).toBe(200);

    const afterRevoke = await getProfile(
      makeRequest(`/api/profiles/${profile.id}`, {
        sessionToken: friend.token,
      }),
      routeParams({ id: profile.id }),
    );
    expect(afterRevoke.status).toBe(404);
  });
});
