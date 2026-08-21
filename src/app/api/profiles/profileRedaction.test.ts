/**
 * The server's own answer to "what may this blob contain?".
 *
 * `src/lib/profileWire.ts` withholds `serverShareToken` on the way out of a
 * *client*. That is the right place to decide, and the wrong place to enforce:
 * the server stores the blob verbatim and hands it back verbatim to anyone
 * authorised to read the profile, so the withholding only ever held for blobs
 * written by a client that had the fix. A blob already at rest — written before
 * it landed — still carries the token, and so does one written by anything that
 * chooses not to filter.
 *
 * So both halves are tested here: nothing on the way in gets stored, and
 * nothing already stored gets served.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, execute, getDb } from "@/lib/server/db";
import { createSession } from "@/lib/server/session";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { createProfile, getProfileById } from "@/lib/server/profiles";
import { upsertEmailShare } from "@/lib/server/shares";
import { makeApiRequest, routeParams } from "@/lib/server/testSupport";

import { POST as postProfile } from "./route";
import { GET as getProfile, PUT as putProfile } from "./[id]/route";

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const SECRET = "sh_a-bearer-credential-nobody-else-may-have";

const signIn = (n: number) => {
  const user = upsertUserFromGoogle({
    sub: `sub-${n}`,
    email: `user${n}@example.com`,
    name: `User ${n}`,
    picture: null,
  });
  return { user, token: createSession(user.id) };
};

/** A blob shaped the way a client writes one, credential included. */
const blobCarryingToken = () => ({
  _syncFormatVersion: 1,
  profile: {
    id: 3,
    name: "Panto",
    syncType: "server",
    serverProfileId: "srv-1",
    serverShareToken: SECRET,
    activePadBehavior: "continue",
  },
  padConfigurations: [],
  pageMetadata: [],
  audioFiles: [],
});

/** An owner, a profile whose *stored* blob carries the token, and a viewer. */
function profileWithLegacyBlobAtRest() {
  const owner = signIn(1);
  const viewer = signIn(2);
  const profile = createProfile({
    ownerId: owner.user.id,
    name: "Panto",
    data: { _syncFormatVersion: 1 },
  });
  // Written straight to the row, because that is the situation: the blob was
  // stored by a client that predates the withholding, and no write since has
  // rewritten it.
  execute(
    "UPDATE profiles SET data = ? WHERE id = ?",
    JSON.stringify(blobCarryingToken()),
    profile.id,
  );
  upsertEmailShare(profile.id, viewer.user.email, "viewer", owner.user.id);
  return { owner, viewer, profile };
}

describe("profile blob redaction", () => {
  it("does not store a share token a client sent", async () => {
    const owner = signIn(1);

    const response = await postProfile(
      makeApiRequest("/api/profiles", {
        method: "POST",
        sessionToken: owner.token,
        body: { name: "Panto", data: blobCarryingToken() },
      }),
    );
    const { id } = await response.json();

    expect(response.status).toBe(201);
    expect(getProfileById(id)!.data).not.toContain(SECRET);
  });

  it("keeps the rest of the profile record when it strips one field", async () => {
    const owner = signIn(1);

    const response = await postProfile(
      makeApiRequest("/api/profiles", {
        method: "POST",
        sessionToken: owner.token,
        body: { name: "Panto", data: blobCarryingToken() },
      }),
    );
    const { id } = await response.json();

    expect(JSON.parse(getProfileById(id)!.data).profile).toEqual({
      id: 3,
      name: "Panto",
      syncType: "server",
      serverProfileId: "srv-1",
      activePadBehavior: "continue",
    });
  });

  it("never serves a token a blob already at rest still carries", async () => {
    const { profile, viewer } = profileWithLegacyBlobAtRest();

    const response = await getProfile(
      makeApiRequest(`/api/profiles/${profile.id}`, {
        sessionToken: viewer.token,
      }),
      routeParams({ id: profile.id }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).data.profile.serverShareToken).toBeUndefined();
    // The rest of the blob still arrives, or the viewer has no profile.
    expect(JSON.parse(text).data.profile.name).toBe("Panto");
  });

  it("keeps it out of the blob a 409 hands back", async () => {
    const { owner, profile } = profileWithLegacyBlobAtRest();

    const response = await putProfile(
      makeApiRequest(`/api/profiles/${profile.id}`, {
        method: "PUT",
        sessionToken: owner.token,
        // Deliberately stale, so the conflict body is what comes back.
        headers: { "if-match": `"${profile.version + 5}"` },
        body: { name: "Panto", data: { _syncFormatVersion: 1 } },
      }),
      routeParams({ id: profile.id }),
    );
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).not.toContain(SECRET);
  });
});
