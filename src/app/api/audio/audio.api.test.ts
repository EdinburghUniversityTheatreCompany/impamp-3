/**
 * Integration tests for the hosted-audio API, driving the real route handlers
 * against a real (in-memory) database and an in-memory object store.
 *
 * Nothing here touches a network or needs credentials: `setObjectStoreForTests`
 * swaps the S3 client for `createFakeObjectStore`.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, execute, getDb } from "@/lib/server/db";
import { createSession } from "@/lib/server/session";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { createProfile } from "@/lib/server/profiles";
import { createLinkShare, upsertEmailShare } from "@/lib/server/shares";
import { setObjectStoreForTests } from "@/lib/server/audioRequests";
import { proofRangeFor } from "@/lib/server/proofOfPossession";
import {
  makeApiRequest as makeRequest,
  routeParams,
} from "@/lib/server/testSupport";
import {
  createFakeObjectStore,
  type FakeObjectStore,
} from "@/lib/server/s3/fakeObjectStore";
import type { AudioHostingConfig } from "@/lib/server/s3/config";
import { objectKeyForHash } from "@/lib/server/s3/client";

import { GET as listAudio } from "./route";
import { POST as uploadUrl } from "./upload-url/route";
import { POST as commit } from "./commit/route";
import { DELETE as deleteAudio, GET as downloadUrl } from "./[hash]/route";
import { GET as profileAudio } from "../profiles/[id]/audio/[hash]/route";
import { GET as adminAudio } from "../admin/audio/route";
import { PATCH as patchUser } from "../admin/users/[id]/route";

const KB = 1024;

const config: AudioHostingConfig = {
  endpoint: "https://s3.test.example",
  region: "eu-central-2",
  bucket: "impamp-audio",
  accessKeyId: "key",
  secretAccessKey: "secret",
  globalCapBytes: 100 * KB,
  defaultUserQuotaBytes: 10 * KB,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 3600,
  maxObjectBytes: 8 * KB,
};

let store: FakeObjectStore;

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
  store = createFakeObjectStore();
  setObjectStoreForTests({ store, config });
});

afterEach(() => setObjectStoreForTests(null));

const signIn = (n: number, { approved = false, admin = false } = {}) => {
  const user = upsertUserFromGoogle({
    sub: `sub-${n}`,
    email: `user${n}@example.com`,
    name: `User ${n}`,
    picture: null,
  });
  if (approved) {
    execute("UPDATE users SET can_upload_audio = 1 WHERE id = ?", user.id);
  }
  // The first user bootstraps as admin; force the column either way.
  execute("UPDATE users SET is_admin = ? WHERE id = ?", admin ? 1 : 0, user.id);
  return { user, token: createSession(user.id) };
};

const hashOf = (label: string) =>
  createHash("sha256").update(label).digest("hex");

/** The whole happy path: ask, upload, commit. */
/**
 * The bytes a label stands for. Deterministic, so two users "holding the same
 * file" really do hold the same bytes — which is what proof of possession is
 * about.
 */
function bytesFor(label: string, sizeBytes: number): Uint8Array {
  const seed = createHash("sha256").update(label).digest();
  const out = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) out[i] = seed[i % seed.length];
  return out;
}

/** What a client that genuinely holds the file sends to claim a stored one. */
function proofFor(
  bytes: Uint8Array,
  range: { offset: number; length: number } | null,
): string | undefined {
  if (!range) return undefined;
  return createHash("sha256")
    .update(bytes.slice(range.offset, range.offset + range.length))
    .digest("hex");
}

async function storeAudio(
  token: string,
  label: string,
  sizeBytes: number,
  name = `${label}.wav`,
) {
  const hash = hashOf(label);
  const bytes = bytesFor(label, sizeBytes);
  const askResponse = await uploadUrl(
    makeRequest("/api/audio/upload-url", {
      method: "POST",
      sessionToken: token,
      body: { hash, sizeBytes, contentType: "audio/wav", extension: "wav" },
    }),
  );
  const ask = await askResponse.json();
  if (askResponse.status !== 200) return { status: askResponse.status, ask };

  // Stand in for the browser's PUT straight to the bucket.
  if (!ask.alreadyStored) {
    store.putBytes(ask.key, bytes, "audio/wav");
  }

  const commitResponse = await commit(
    makeRequest("/api/audio/commit", {
      method: "POST",
      sessionToken: token,
      body: {
        hash,
        name,
        contentType: "audio/wav",
        extension: "wav",
        proof: proofFor(bytes, ask.proofRange ?? null),
      },
    }),
  );

  return {
    status: commitResponse.status,
    ask,
    commit: await commitResponse.json(),
    hash,
  };
}

describe("POST /api/audio/upload-url", () => {
  it("refuses an anonymous caller", async () => {
    const response = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        body: {
          hash: hashOf("a"),
          sizeBytes: 10,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a signed-in user who is not approved", async () => {
    const { token } = signIn(1);
    const result = await storeAudio(token, "a", KB);

    expect(result.status).toBe(403);
    expect(result.ask.reason).toBe("not_approved");
  });

  it("mints an upload URL for an approved user", async () => {
    const { token } = signIn(1, { approved: true });
    const response = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: token,
        body: {
          hash: hashOf("a"),
          sizeBytes: KB,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uploadUrl).toContain("upload=1");
    expect(body.key).toBe(objectKeyForHash(hashOf("a"), "wav"));
    expect(body.alreadyStored).toBe(false);
  });

  it("rejects a non-audio content type", async () => {
    const { token } = signIn(1, { approved: true });
    const response = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: token,
        body: {
          hash: hashOf("a"),
          sizeBytes: KB,
          contentType: "text/html",
          extension: "html",
        },
      }),
    );
    expect(response.status).toBe(415);
  });

  it("rejects a malformed hash", async () => {
    const { token } = signIn(1, { approved: true });
    const response = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: token,
        body: {
          hash: "not-a-hash",
          sizeBytes: KB,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("skips the upload when the bytes are already in the bucket", async () => {
    const first = signIn(1, { approved: true });
    const second = signIn(2, { approved: true });
    await storeAudio(first.token, "shared", KB);

    const response = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: second.token,
        body: {
          hash: hashOf("shared"),
          sizeBytes: KB,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    const body = await response.json();

    expect(body.alreadyStored).toBe(true);
    expect(body.uploadUrl).toBeNull();
  });
});

describe("POST /api/audio/commit", () => {
  it("records the size the bucket reports, not the one the client claimed", async () => {
    const { token } = signIn(1, { approved: true });
    const hash = hashOf("liar");

    // Ask for 1 byte...
    await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: token,
        body: {
          hash,
          sizeBytes: 1,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    // ...then actually upload 4K.
    store.put(objectKeyForHash(hash, "wav"), 4 * KB, "audio/wav");

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: token,
        body: {
          hash,
          name: "liar.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    const body = await response.json();

    expect(body.sizeBytes).toBe(4 * KB);
    expect(body.usage.usedBytes).toBe(4 * KB);
  });

  it("deletes the object and refuses when the real size blows the quota", async () => {
    const { token } = signIn(1, { approved: true });
    const hash = hashOf("toobig");

    await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: token,
        body: {
          hash,
          sizeBytes: 1,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    // 9K against a 8K per-object ceiling.
    store.put(objectKeyForHash(hash, "wav"), 9 * KB, "audio/wav");

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: token,
        body: {
          hash,
          name: "toobig.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );

    expect(response.status).toBe(413);
    // The bytes we refused to account for are not left behind.
    expect(store.keys()).toEqual([]);
  });

  it("does not delete a shared object when refusing a second uploader", async () => {
    const first = signIn(1, { approved: true });
    const second = signIn(2, { approved: true });
    await storeAudio(first.token, "shared", 6 * KB);

    // Fill the second user up so committing the shared object is refused.
    await storeAudio(second.token, "own", 6 * KB);
    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: second.token,
        body: {
          hash: hashOf("shared"),
          name: "shared.wav",
          contentType: "audio/wav",
          extension: "wav",
          // This user really does hold the same file, so it can prove it —
          // the refusal under test is the quota one, not the proof one.
          proof: proofFor(
            bytesFor("shared", 6 * KB),
            proofRangeFor(hashOf("shared"), 6 * KB),
          ),
        },
      }),
    );

    expect(response.status).toBe(413);
    // The first user's audio survives the second user's refusal.
    expect(store.keys()).toContain(objectKeyForHash(hashOf("shared"), "wav"));
  });

  it("refuses someone who knows the hash but not the bytes", async () => {
    // The escalation this closes: hashes are not secret. Every profile blob
    // names the hashes of its sounds, and GET /api/profiles/:id hands that blob
    // to anyone allowed to *read* the profile, viewers included. Commit used to
    // confirm only that the key existed — which `head` answers without knowing
    // anything about the caller — and then record a reference. A reference is
    // what profileMayServeHash counts when deciding who may fetch the bytes, so
    // seeing a hash was enough to be granted the audio behind it.
    const owner = signIn(1, { approved: true });
    const attacker = signIn(2, { approved: true });
    await storeAudio(owner.token, "someone-elses-sound", KB);

    const askResponse = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: attacker.token,
        body: {
          hash: hashOf("someone-elses-sound"),
          sizeBytes: KB,
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    const ask = await askResponse.json();
    // No upload URL is offered, so nothing can be overwritten either.
    expect(ask.alreadyStored).toBe(true);
    expect(ask.uploadUrl).toBeNull();

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: attacker.token,
        body: {
          hash: hashOf("someone-elses-sound"),
          name: "mine-now.wav",
          contentType: "audio/wav",
          extension: "wav",
          // Knowing the hash is all they have.
          proof: hashOf("a guess"),
        },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a claim with no proof at all", async () => {
    const owner = signIn(1, { approved: true });
    const attacker = signIn(2, { approved: true });
    await storeAudio(owner.token, "another-sound", KB);

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: attacker.token,
        body: {
          hash: hashOf("another-sound"),
          name: "mine-now.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("lets the same user re-commit what they already hold", async () => {
    // A retry must stay idempotent: they have been through the challenge once.
    const { token } = signIn(1, { approved: true });
    await storeAudio(token, "mine", KB);

    const again = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: token,
        body: {
          hash: hashOf("mine"),
          name: "mine.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );

    expect(again.status).toBe(200);
  });

  it("404s when no object was actually uploaded", async () => {
    const { token } = signIn(1, { approved: true });
    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: token,
        body: {
          hash: hashOf("ghost"),
          name: "ghost.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("is idempotent when a client retries", async () => {
    const { token } = signIn(1, { approved: true });
    await storeAudio(token, "a", KB);
    const again = await storeAudio(token, "a", KB);

    expect(again.status).toBe(200);
    expect(again.commit.usage.usedBytes).toBe(KB);
    expect(again.commit.usage.fileCount).toBe(1);
  });
});

describe("GET /api/audio", () => {
  it("lists what the user holds with their usage", async () => {
    const { token } = signIn(1, { approved: true });
    await storeAudio(token, "a", KB, "Applause.wav");

    const response = await listAudio(
      makeRequest("/api/audio", { sessionToken: token }),
    );
    const body = await response.json();

    expect(body.canUploadAudio).toBe(true);
    expect(body.usage).toMatchObject({
      usedBytes: KB,
      quotaBytes: 10 * KB,
      fileCount: 1,
    });
    expect(body.files[0]).toMatchObject({
      name: "Applause.wav",
      sizeBytes: KB,
    });
  });
});

describe("GET /api/audio/:hash", () => {
  it("hands the owner a presigned URL", async () => {
    const { token } = signIn(1, { approved: true });
    const { hash } = await storeAudio(token, "a", KB);

    const response = await downloadUrl(
      makeRequest(`/api/audio/${hash}`, { sessionToken: token }),
      routeParams({ hash: hash! }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("download=1");
    expect(body.contentType).toBe("audio/wav");
  });

  it("404s for a user who holds no reference, rather than 403", async () => {
    const owner = signIn(1, { approved: true });
    const stranger = signIn(2, { approved: true });
    const { hash } = await storeAudio(owner.token, "a", KB);

    const response = await downloadUrl(
      makeRequest(`/api/audio/${hash}`, { sessionToken: stranger.token }),
      routeParams({ hash: hash! }),
    );
    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/audio/:hash", () => {
  it("frees the user's quota at once and removes the object", async () => {
    const { token } = signIn(1, { approved: true });
    const { hash } = await storeAudio(token, "a", 4 * KB);

    const response = await deleteAudio(
      makeRequest(`/api/audio/${hash}`, {
        method: "DELETE",
        sessionToken: token,
      }),
      routeParams({ hash: hash! }),
    );
    const body = await response.json();

    expect(body).toEqual({ removed: true, objectDeleted: true });
    expect(store.keys()).toEqual([]);

    const after = await (
      await listAudio(makeRequest("/api/audio", { sessionToken: token }))
    ).json();
    expect(after.usage.usedBytes).toBe(0);
  });

  it("keeps the object while another user still holds it", async () => {
    const first = signIn(1, { approved: true });
    const second = signIn(2, { approved: true });
    await storeAudio(first.token, "shared", KB);
    await storeAudio(second.token, "shared", KB);

    const response = await deleteAudio(
      makeRequest(`/api/audio/${hashOf("shared")}`, {
        method: "DELETE",
        sessionToken: first.token,
      }),
      routeParams({ hash: hashOf("shared") }),
    );

    expect(await response.json()).toEqual({
      removed: true,
      objectDeleted: false,
    });
    expect(store.keys()).toContain(objectKeyForHash(hashOf("shared"), "wav"));
  });

  it("404s when the caller holds no reference", async () => {
    const owner = signIn(1, { approved: true });
    const stranger = signIn(2, { approved: true });
    const { hash } = await storeAudio(owner.token, "a", KB);

    const response = await deleteAudio(
      makeRequest(`/api/audio/${hash}`, {
        method: "DELETE",
        sessionToken: stranger.token,
      }),
      routeParams({ hash: hash! }),
    );
    expect(response.status).toBe(404);
    expect(store.keys()).toHaveLength(1);
  });
});

describe("GET /api/profiles/:id/audio/:hash", () => {
  const profileWith = (ownerId: number, hashes: string[]) =>
    createProfile({
      ownerId,
      name: "Show",
      data: {
        _syncFormatVersion: 2,
        audioFiles: hashes.map((hash, index) => ({
          id: index,
          name: `sound-${index}.wav`,
          type: "audio/wav",
          hash,
        })),
      },
    });

  it("lets an anonymous link-share holder fetch audio the profile lists", async () => {
    const owner = signIn(1, { approved: true });
    const { hash } = await storeAudio(owner.token, "a", KB);
    const profile = profileWith(owner.user.id, [hash!]);
    const share = createLinkShare(profile.id, "viewer", owner.user.id);

    const response = await profileAudio(
      makeRequest(`/api/profiles/${profile.id}/audio/${hash}`, {
        query: `token=${share.link_token}`,
      }),
      routeParams({ id: profile.id, hash: hash! }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).url).toContain("download=1");
  });

  it("refuses a hash the profile does not list, so a share is not a skeleton key", async () => {
    const owner = signIn(1, { approved: true });
    const listed = await storeAudio(owner.token, "listed", KB);
    const unlisted = await storeAudio(owner.token, "unlisted", KB);
    const profile = profileWith(owner.user.id, [listed.hash!]);
    const share = createLinkShare(profile.id, "viewer", owner.user.id);

    const response = await profileAudio(
      makeRequest(`/api/profiles/${profile.id}/audio/${unlisted.hash}`, {
        query: `token=${share.link_token}`,
      }),
      routeParams({ id: profile.id, hash: unlisted.hash! }),
    );

    expect(response.status).toBe(404);
  });

  it("lets a second user host the same bytes under a different filename", async () => {
    // Keys carry an extension, so identical audio named `kick.mp3` and `kick`
    // produced two keys. The second uploader was told the bytes were already
    // stored — the hash was known — handed no upload URL, and then 404'd at
    // commit against a key nothing had written. They could never host it.
    const first = signIn(1, { approved: true });
    const second = signIn(2, { approved: true });
    const stored = await storeAudio(first.token, "shared-bytes", KB);
    expect(stored.status).toBe(200);

    const askResponse = await uploadUrl(
      makeRequest("/api/audio/upload-url", {
        method: "POST",
        sessionToken: second.token,
        body: {
          hash: stored.hash,
          sizeBytes: KB,
          contentType: "audio/wav",
          // Same bytes, no extension this time.
          extension: "",
        },
      }),
    );
    expect(askResponse.status).toBe(200);
    const ask = await askResponse.json();

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: second.token,
        body: {
          hash: stored.hash,
          name: "theirs.wav",
          contentType: "audio/wav",
          extension: "",
          // The second user holds the same file, so it can answer the
          // possession challenge the dedup path now asks for.
          proof: proofFor(bytesFor("shared-bytes", KB), ask.proofRange),
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("refuses to delete a sound a profile is still using", async () => {
    // Letting go of the last reference removed the bytes without asking
    // whether a board still played them, so tidying your library could make
    // your own live profile 404.
    const owner = signIn(1, { approved: true });
    const { hash } = await storeAudio(owner.token, "in-use", KB);
    profileWith(owner.user.id, [hash!]);

    const response = await deleteAudio(
      makeRequest(`/api/audio/${hash}`, {
        method: "DELETE",
        sessionToken: owner.token,
      }),
      routeParams({ hash: hash! }),
    );

    expect(response.status).toBe(409);
  });

  it("re-checks the quota when the bytes behind a held hash change", async () => {
    // The presigned PUT signs only `host`, so a holder can replace the object
    // with something far larger and commit again. Re-committing a hash you
    // already hold skipped the size and quota checks entirely, while the
    // recorded size was taken from the bucket — so the new size was billed
    // straight past both limits.
    const user = signIn(1, { approved: true });
    const first = await storeAudio(user.token, "small", KB);
    expect(first.status).toBe(200);

    // Same key, far bigger bytes, then commit again.
    const key = objectKeyForHash(first.hash!, "wav");
    store.put(key, config.maxObjectBytes + KB, "audio/wav");

    const response = await commit(
      makeRequest("/api/audio/commit", {
        method: "POST",
        sessionToken: user.token,
        body: {
          hash: first.hash,
          name: "small.wav",
          contentType: "audio/wav",
          extension: "wav",
        },
      }),
    );

    expect(response.status).not.toBe(200);
  });

  it("refuses a hash nobody who can publish here ever uploaded", async () => {
    // The blob is the caller's own word. Anyone can create a profile and list
    // any hash in it, so "the profile lists it" made this a fetch-by-hash
    // service for the whole bucket — and meant revoking a share left the
    // audio reachable, since the attacker kept the hashes they had seen.
    const victim = signIn(1, { approved: true });
    const attacker = signIn(2, { approved: true });
    const { hash } = await storeAudio(victim.token, "secret", KB);

    // The attacker's own profile, naming someone else's sound.
    const theirs = profileWith(attacker.user.id, [hash!]);

    const response = await profileAudio(
      makeRequest(`/api/profiles/${theirs.id}/audio/${hash}`, {
        sessionToken: attacker.token,
      }),
      routeParams({ id: theirs.id, hash: hash! }),
    );

    expect(response.status).toBe(404);
  });

  it("still serves a sound an editor added to someone else's profile", async () => {
    // The owner must not be refused audio their own collaborators uploaded,
    // which is why the check is "anyone who can publish here", not "the owner".
    const owner = signIn(1, { approved: true });
    const editor = signIn(2, { approved: true });
    const { hash } = await storeAudio(editor.token, "editors-sound", KB);
    const profile = profileWith(owner.user.id, [hash!]);
    upsertEmailShare(profile.id, editor.user.email, "editor", owner.user.id);

    const response = await profileAudio(
      makeRequest(`/api/profiles/${profile.id}/audio/${hash}`, {
        sessionToken: owner.token,
      }),
      routeParams({ id: profile.id, hash: hash! }),
    );

    expect(response.status).toBe(200);
  });

  it("refuses someone with no access to the profile at all", async () => {
    const owner = signIn(1, { approved: true });
    const stranger = signIn(2);
    const { hash } = await storeAudio(owner.token, "a", KB);
    const profile = profileWith(owner.user.id, [hash!]);

    const response = await profileAudio(
      makeRequest(`/api/profiles/${profile.id}/audio/${hash}`, {
        sessionToken: stranger.token,
      }),
      routeParams({ id: profile.id, hash: hash! }),
    );
    expect(response.status).toBe(404);
  });
});

describe("admin surface", () => {
  it("is invisible to a non-admin", async () => {
    const { token } = signIn(1, { approved: true });
    const response = await adminAudio(
      makeRequest("/api/admin/audio", { sessionToken: token }),
    );
    expect(response.status).toBe(404);
  });

  it("reports the global total and each user's usage", async () => {
    const admin = signIn(1, { admin: true });
    const heavy = signIn(2, { approved: true });
    await storeAudio(heavy.token, "a", 5 * KB);

    const response = await adminAudio(
      makeRequest("/api/admin/audio", { sessionToken: admin.token }),
    );
    const body = await response.json();

    expect(body.global).toMatchObject({
      usedBytes: 5 * KB,
      capBytes: 100 * KB,
      objectCount: 1,
    });
    expect(body.users[0]).toMatchObject({
      email: "user2@example.com",
      usedBytes: 5 * KB,
      canUploadAudio: true,
    });
  });

  it("counts a shared object once globally but against both users", async () => {
    const admin = signIn(1, { admin: true });
    const first = signIn(2, { approved: true });
    const second = signIn(3, { approved: true });
    await storeAudio(first.token, "shared", 4 * KB);
    await storeAudio(second.token, "shared", 4 * KB);

    const body = await (
      await adminAudio(
        makeRequest("/api/admin/audio", { sessionToken: admin.token }),
      )
    ).json();

    expect(body.global.usedBytes).toBe(4 * KB);
    expect(body.global.objectCount).toBe(1);
    expect(
      body.users
        .filter((u: { usedBytes: number }) => u.usedBytes > 0)
        .map((u: { usedBytes: number }) => u.usedBytes),
    ).toEqual([4 * KB, 4 * KB]);
  });

  it("approves a user for uploads", async () => {
    const admin = signIn(1, { admin: true });
    const user = signIn(2);

    const response = await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { canUploadAudio: true },
      }),
      routeParams({ id: String(user.user.id) }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).canUploadAudio).toBe(true);

    // And the approval actually takes effect.
    const result = await storeAudio(user.token, "a", KB);
    expect(result.status).toBe(200);
  });

  it("sets a per-user allowance and can hand it back to the default", async () => {
    const admin = signIn(1, { admin: true });
    const user = signIn(2, { approved: true });

    await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { audioQuotaBytes: 2 * KB },
      }),
      routeParams({ id: String(user.user.id) }),
    );
    expect((await storeAudio(user.token, "big", 3 * KB)).status).toBe(413);

    const reset = await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { audioQuotaBytes: null },
      }),
      routeParams({ id: String(user.user.id) }),
    );
    expect((await reset.json()).usage.quotaBytes).toBe(10 * KB);
  });

  it("does not reset an allowance when only toggling approval", async () => {
    const admin = signIn(1, { admin: true });
    const user = signIn(2);

    await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { audioQuotaBytes: 3 * KB },
      }),
      routeParams({ id: String(user.user.id) }),
    );
    const response = await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { canUploadAudio: true },
      }),
      routeParams({ id: String(user.user.id) }),
    );

    expect((await response.json()).usage.quotaBytes).toBe(3 * KB);
  });

  it("rejects a nonsense allowance", async () => {
    const admin = signIn(1, { admin: true });
    const user = signIn(2);

    const response = await patchUser(
      makeRequest(`/api/admin/users/${user.user.id}`, {
        method: "PATCH",
        sessionToken: admin.token,
        body: { audioQuotaBytes: -5 },
      }),
      routeParams({ id: String(user.user.id) }),
    );
    expect(response.status).toBe(400);
  });
});
