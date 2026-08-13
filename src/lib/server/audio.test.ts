import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, execute, getDb } from "./db";
import { upsertUserFromGoogle } from "./users";
import {
  canUpload,
  getGlobalUsage,
  getUserUsage,
  listUserAudio,
  listUserUsage,
  recordUpload,
  releaseReference,
  userHoldsReference,
} from "./audio";

const KB = 1024;
const DEFAULT_QUOTA = 10 * KB;
const GLOBAL_CAP = 100 * KB;
const MAX_OBJECT = 8 * KB;

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
  getDb();
});

const googleUser = (n: number) => ({
  sub: `google-sub-${n}`,
  email: `user${n}@example.com`,
  name: `User ${n}`,
  picture: null,
});

/** A user allowed to upload, which is not the default. */
function approvedUser(n: number) {
  const user = upsertUserFromGoogle(googleUser(n));
  execute("UPDATE users SET can_upload_audio = 1 WHERE id = ?", user.id);
  return user;
}

/**
 * A real digest of the label. Padding a label to 64 characters looks simpler
 * but collides — "fill1" and "fill10" both pad to the same string.
 */
const hash = (label: string) =>
  createHash("sha256").update(label).digest("hex");

function upload(userId: number, label: string, sizeBytes: number) {
  recordUpload({
    userId,
    hash: hash(label),
    sizeBytes,
    contentType: "audio/wav",
    extension: "wav",
    name: `${label}.wav`,
  });
}

describe("usage accounting", () => {
  it("starts everyone at zero", () => {
    const user = approvedUser(1);
    expect(getUserUsage(user.id, DEFAULT_QUOTA)).toEqual({
      usedBytes: 0,
      fileCount: 0,
      quotaBytes: DEFAULT_QUOTA,
    });
  });

  it("sums a user's objects", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 1000);
    upload(user.id, "b", 2000);

    const usage = getUserUsage(user.id, DEFAULT_QUOTA);
    expect(usage.usedBytes).toBe(3000);
    expect(usage.fileCount).toBe(2);
  });

  it("charges both holders of a shared object, but counts it once globally", () => {
    // The bucket holds one blob; either user could be the last to release it,
    // so each is charged the full size.
    const first = approvedUser(1);
    const second = approvedUser(2);
    upload(first.id, "shared", 4000);
    upload(second.id, "shared", 4000);

    expect(getUserUsage(first.id, DEFAULT_QUOTA).usedBytes).toBe(4000);
    expect(getUserUsage(second.id, DEFAULT_QUOTA).usedBytes).toBe(4000);
    expect(getGlobalUsage(GLOBAL_CAP).usedBytes).toBe(4000);
    expect(getGlobalUsage(GLOBAL_CAP).objectCount).toBe(1);
  });

  it("honours a per-user override without touching anyone else", () => {
    const user = approvedUser(1);
    const other = approvedUser(2);
    execute("UPDATE users SET audio_quota_bytes = ? WHERE id = ?", 99, user.id);

    expect(getUserUsage(user.id, DEFAULT_QUOTA).quotaBytes).toBe(99);
    expect(getUserUsage(other.id, DEFAULT_QUOTA).quotaBytes).toBe(
      DEFAULT_QUOTA,
    );
  });

  it("lists every user for the admin view, heaviest first", () => {
    const light = approvedUser(1);
    const heavy = approvedUser(2);
    upsertUserFromGoogle(googleUser(3)); // never uploaded, still listed
    upload(light.id, "a", 100);
    upload(heavy.id, "b", 5000);

    const rows = listUserUsage(DEFAULT_QUOTA);
    expect(rows.map((r) => r.email)).toEqual([
      "user2@example.com",
      "user1@example.com",
      "user3@example.com",
    ]);
    expect(rows[0].usedBytes).toBe(5000);
    expect(rows[2].usedBytes).toBe(0);
    expect(rows[2].canUploadAudio).toBe(false);
  });
});

describe("canUpload", () => {
  const decide = (
    userId: number,
    canUploadAudio: boolean,
    label: string,
    sizeBytes: number,
    quotaBytes = DEFAULT_QUOTA,
  ) =>
    canUpload({
      userId,
      canUploadAudio,
      hash: hash(label),
      sizeBytes,
      quotaBytes,
      capBytes: GLOBAL_CAP,
      maxObjectBytes: MAX_OBJECT,
    });

  it("refuses a user who has not been approved", () => {
    const user = upsertUserFromGoogle(googleUser(1));
    expect(decide(user.id, false, "a", 100)).toEqual({
      allowed: false,
      reason: "not_approved",
    });
  });

  it("allows an approved user within quota", () => {
    const user = approvedUser(1);
    expect(decide(user.id, true, "a", 100)).toEqual({
      allowed: true,
      alreadyStored: false,
    });
  });

  it("refuses a single object over the per-object ceiling", () => {
    const user = approvedUser(1);
    expect(decide(user.id, true, "a", MAX_OBJECT + 1)).toMatchObject({
      allowed: false,
      reason: "too_large",
    });
  });

  it("refuses an upload that would cross the user's quota", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 9 * KB);

    expect(decide(user.id, true, "b", 2 * KB)).toMatchObject({
      allowed: false,
      reason: "user_quota",
      detail: { usedBytes: 9 * KB, limitBytes: DEFAULT_QUOTA },
    });
  });

  it("allows an upload that exactly reaches the quota", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 9 * KB);
    expect(decide(user.id, true, "b", 1 * KB)).toMatchObject({ allowed: true });
  });

  it("refuses when the deployment-wide cap would be crossed", () => {
    const user = approvedUser(1);
    execute(
      "UPDATE users SET audio_quota_bytes = ? WHERE id = ?",
      GLOBAL_CAP * 2,
      user.id,
    );
    // Fill the bucket via other users so this user's own quota is not the binding limit.
    for (let n = 0; n < 13; n++) {
      const filler = approvedUser(100 + n);
      upload(filler.id, `fill${n}`, MAX_OBJECT);
    }

    expect(getGlobalUsage(GLOBAL_CAP).usedBytes).toBe(13 * MAX_OBJECT);
    expect(
      decide(user.id, true, "over", MAX_OBJECT, GLOBAL_CAP * 2),
    ).toMatchObject({ allowed: false, reason: "global_cap" });
  });

  it("never fails on quota for a sound the user already holds", () => {
    // Re-adding a sound you already have must not be blocked, even when the
    // account is otherwise full.
    const user = approvedUser(1);
    upload(user.id, "a", MAX_OBJECT);
    execute(
      "UPDATE users SET audio_quota_bytes = ? WHERE id = ?",
      MAX_OBJECT,
      user.id,
    );

    expect(decide(user.id, true, "a", MAX_OBJECT, MAX_OBJECT)).toEqual({
      allowed: true,
      alreadyStored: true,
    });
  });

  it("charges the real stored size, not the size the client claimed", () => {
    // A client under-declaring the size must not slip past the quota check:
    // 5K held + 6K real = over the 10K quota, where 5K + the claimed 1 byte
    // would have sailed through.
    const owner = approvedUser(1);
    const other = approvedUser(2);
    upload(owner.id, "big", 6 * KB);
    upload(other.id, "own", 5 * KB);

    expect(decide(other.id, true, "big", 1)).toMatchObject({
      allowed: false,
      reason: "user_quota",
    });
  });

  it("does not recount the global cap for a blob already in the bucket", () => {
    const first = approvedUser(1);
    const second = approvedUser(2);
    upload(first.id, "shared", MAX_OBJECT);

    expect(decide(second.id, true, "shared", MAX_OBJECT)).toEqual({
      allowed: true,
      alreadyStored: true,
    });
  });
});

describe("recordUpload", () => {
  it("is idempotent, so a retried commit charges once", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 1000);
    upload(user.id, "a", 1000);

    expect(getUserUsage(user.id, DEFAULT_QUOTA)).toMatchObject({
      usedBytes: 1000,
      fileCount: 1,
    });
  });

  it("records what the user holds", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 1000);

    const [row] = listUserAudio(user.id);
    expect(row).toMatchObject({
      hash: hash("a"),
      name: "a.wav",
      size_bytes: 1000,
      content_type: "audio/wav",
    });
  });
});

describe("releaseReference", () => {
  it("frees the user's quota immediately", () => {
    const user = approvedUser(1);
    upload(user.id, "a", 5000);

    expect(releaseReference(user.id, hash("a"))).toEqual({
      removed: true,
      orphaned: true,
    });
    expect(getUserUsage(user.id, DEFAULT_QUOTA).usedBytes).toBe(0);
    expect(getGlobalUsage(GLOBAL_CAP).usedBytes).toBe(0);
  });

  it("keeps a shared object alive while anyone still holds it", () => {
    const first = approvedUser(1);
    const second = approvedUser(2);
    upload(first.id, "shared", 4000);
    upload(second.id, "shared", 4000);

    expect(releaseReference(first.id, hash("shared"))).toEqual({
      removed: true,
      orphaned: false,
    });
    expect(getUserUsage(first.id, DEFAULT_QUOTA).usedBytes).toBe(0);
    expect(getUserUsage(second.id, DEFAULT_QUOTA).usedBytes).toBe(4000);
    expect(getGlobalUsage(GLOBAL_CAP).objectCount).toBe(1);

    expect(releaseReference(second.id, hash("shared"))).toEqual({
      removed: true,
      orphaned: true,
    });
    expect(getGlobalUsage(GLOBAL_CAP).objectCount).toBe(0);
  });

  it("reports nothing removed when the user held no reference", () => {
    const user = approvedUser(1);
    expect(releaseReference(user.id, hash("never"))).toEqual({
      removed: false,
      orphaned: false,
    });
  });

  it("does not let one user release another's reference", () => {
    const owner = approvedUser(1);
    const stranger = approvedUser(2);
    upload(owner.id, "a", 1000);

    expect(releaseReference(stranger.id, hash("a")).removed).toBe(false);
    expect(userHoldsReference(owner.id, hash("a"))).toBe(true);
  });
});
