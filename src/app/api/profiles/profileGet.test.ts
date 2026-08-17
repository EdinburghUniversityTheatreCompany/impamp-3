/**
 * What `GET /api/profiles/:id` reads, and how many times.
 *
 * The handler resolves access for the ETag and then again for the blob, which
 * is two authorisations and two reads for one response. The second read is the
 * one that matters: a PUT landing between them yields an ETag naming version N
 * on a body whose `version` is N+1, and `parseVersionHeader` explicitly
 * supports feeding a GET's ETag back as `If-Match` — so a client that does
 * takes a needless 409.
 *
 * The race is deterministic here because `getProfileMeta` is wrapped: the write
 * lands at exactly the moment the real one would have to lose it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/server/db";
import { createSession } from "@/lib/server/session";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { makeApiRequest, routeParams } from "@/lib/server/testSupport";

/** Run once, after the next `getProfileMeta`, then cleared. */
let afterMetaRead: (() => void) | null = null;

vi.mock("@/lib/server/profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/profiles")>();
  return {
    ...actual,
    getProfileMeta: (id: string) => {
      const meta = actual.getProfileMeta(id);
      const hook = afterMetaRead;
      afterMetaRead = null;
      hook?.();
      return meta;
    },
  };
});

const resolveAccessCalls = vi.fn();
vi.mock("@/lib/server/shares", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/shares")>();
  return {
    ...actual,
    resolveAccess: (request: Parameters<typeof actual.resolveAccess>[0]) => {
      resolveAccessCalls();
      return actual.resolveAccess(request);
    },
  };
});

const { createProfile, updateProfile } = await import("@/lib/server/profiles");
const { GET: getProfile } = await import("./[id]/route");

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
  afterMetaRead = null;
  resolveAccessCalls.mockClear();
});

function ownedProfile() {
  const user = upsertUserFromGoogle({
    sub: "sub-1",
    email: "owner@example.com",
    name: "Owner",
    picture: null,
  });
  const profile = createProfile({
    ownerId: user.id,
    name: "Panto",
    data: { _syncFormatVersion: 1, padConfigurations: [] },
  });
  return { user, profile, token: createSession(user.id) };
}

describe("GET /api/profiles/:id", () => {
  it("emits an ETag for the version it actually served", async () => {
    const { profile, token, user } = ownedProfile();

    // A write lands between the ETag read and the body read.
    afterMetaRead = () => {
      updateProfile(profile.id, {
        name: "Panto",
        data: { _syncFormatVersion: 1, padConfigurations: [], v: 2 },
        expectedVersion: profile.version,
        writerId: user.id,
      });
    };

    const response = await getProfile(
      makeApiRequest(`/api/profiles/${profile.id}`, { sessionToken: token }),
      routeParams({ id: profile.id }),
    );
    const body = await response.json();

    expect(response.headers.get("ETag")).toBe(`"${body.version}.owner"`);
  });

  it("authorises once for a full-body response", async () => {
    const { profile, token } = ownedProfile();

    await getProfile(
      makeApiRequest(`/api/profiles/${profile.id}`, { sessionToken: token }),
      routeParams({ id: profile.id }),
    );

    expect(resolveAccessCalls).toHaveBeenCalledTimes(1);
  });

  it("still answers 304 to a matching If-None-Match", async () => {
    const { profile, token } = ownedProfile();

    const response = await getProfile(
      makeApiRequest(`/api/profiles/${profile.id}`, {
        sessionToken: token,
        headers: { "if-none-match": `"${profile.version}.owner"` },
      }),
      routeParams({ id: profile.id }),
    );

    expect(response.status).toBe(304);
    expect(resolveAccessCalls).toHaveBeenCalledTimes(1);
  });
});
