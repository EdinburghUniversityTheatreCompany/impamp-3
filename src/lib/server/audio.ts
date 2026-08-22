/**
 * Accounting for hosted audio: who holds what, how much it comes to, and
 * whether another upload is allowed.
 *
 * Two rules shape everything here:
 *
 * 1. **Objects are content-addressed and shared.** Two people uploading the
 *    same sound produce one object and two references. Each of them is
 *    charged for it, because either could be the last to let it go; the
 *    global total counts it once, because that is what the bucket holds.
 * 2. **Deleting frees quota immediately.** Wasabi still bills a 90-day
 *    minimum per object, so the deployment absorbs a residual cost the
 *    numbers here do not show. That was a deliberate call in favour of
 *    predictable behaviour for users — see docs/wasabi-audio.md.
 *
 * Server-only.
 */

import {
  execute,
  queryAll,
  queryOne,
  transaction,
  type AudioObjectRow,
} from "./db";
import { objectKeyForHash } from "./s3/client";

export interface AudioUsage {
  /** Bytes this user is charged for. */
  usedBytes: number;
  /** Their ceiling, whether the default or an override. */
  quotaBytes: number;
  /** Objects they hold a reference to. */
  fileCount: number;
}

export interface GlobalAudioUsage {
  /** Bytes actually held in the bucket — shared objects counted once. */
  usedBytes: number;
  capBytes: number;
  objectCount: number;
}

export interface UserAudioUsage extends AudioUsage {
  userId: number;
  email: string;
  name: string | null;
  canUploadAudio: boolean;
}

/** What a user is allowed, falling back to the deployment default. */
export function quotaForUser(
  userId: number,
  defaultQuotaBytes: number,
): number {
  const row = queryOne<{ audio_quota_bytes: number | null }>(
    "SELECT audio_quota_bytes FROM users WHERE id = ?",
    userId,
  );
  return row?.audio_quota_bytes ?? defaultQuotaBytes;
}

export function getUserUsage(
  userId: number,
  defaultQuotaBytes: number,
): AudioUsage {
  const row = queryOne<{ used: number | null; files: number }>(
    `SELECT COALESCE(SUM(o.size_bytes), 0) AS used, COUNT(*) AS files
       FROM audio_references r
       JOIN audio_objects o ON o.hash = r.hash
      WHERE r.user_id = ?`,
    userId,
  );

  return {
    usedBytes: row?.used ?? 0,
    fileCount: row?.files ?? 0,
    quotaBytes: quotaForUser(userId, defaultQuotaBytes),
  };
}

export function getGlobalUsage(capBytes: number): GlobalAudioUsage {
  const row = queryOne<{ used: number | null; objects: number }>(
    "SELECT COALESCE(SUM(size_bytes), 0) AS used, COUNT(*) AS objects FROM audio_objects",
  );

  return {
    usedBytes: row?.used ?? 0,
    objectCount: row?.objects ?? 0,
    capBytes,
  };
}

/** Every user who could hold audio, for the admin view. */
export function listUserUsage(defaultQuotaBytes: number): UserAudioUsage[] {
  return queryAll<{
    id: number;
    email: string;
    name: string | null;
    can_upload_audio: number;
    audio_quota_bytes: number | null;
    used: number | null;
    files: number;
  }>(
    `SELECT u.id, u.email, u.name, u.can_upload_audio, u.audio_quota_bytes,
            COALESCE(SUM(o.size_bytes), 0) AS used,
            COUNT(r.id) AS files
       FROM users u
       LEFT JOIN audio_references r ON r.user_id = u.id
       LEFT JOIN audio_objects o ON o.hash = r.hash
      GROUP BY u.id
      ORDER BY used DESC, u.email ASC`,
  ).map((row) => ({
    userId: row.id,
    email: row.email,
    name: row.name,
    canUploadAudio: row.can_upload_audio === 1,
    usedBytes: row.used ?? 0,
    fileCount: row.files,
    quotaBytes: row.audio_quota_bytes ?? defaultQuotaBytes,
  }));
}

export function getAudioObject(hash: string): AudioObjectRow | undefined {
  return queryOne<AudioObjectRow>(
    "SELECT * FROM audio_objects WHERE hash = ?",
    hash,
  );
}

export function userHoldsReference(userId: number, hash: string): boolean {
  return (
    queryOne<{ one: number }>(
      "SELECT 1 AS one FROM audio_references WHERE user_id = ? AND hash = ?",
      userId,
      hash,
    ) !== undefined
  );
}

/**
 * Whether this sound could legitimately have been put on this profile.
 *
 * Access to the profile is necessary but not sufficient, because a caller
 * writes their own profile's data: naming someone else's hash in a board you
 * own used to be enough to be handed that sound. The blob is the caller's
 * word; a reference row is the server's own record of who uploaded what.
 *
 * "Could have put it there" means the owner holds it, or the person recorded
 * as having attached it to this profile holds it. Restricting it to the owner
 * alone would refuse an owner the sounds their own collaborators added.
 *
 * There used to be a third way to say yes — "a current email-share editor
 * holds it" — and it was an authorization bypass. Inviting an email is
 * unilateral: `upsertEmailShare` writes the row on the inviter's say-so, with
 * no acceptance step. So the owner of any profile could manufacture the grant:
 * name a hash you do not hold, invite the person who does, and the bucket
 * serves it. In practice that let anyone who had ever been shown a board
 * re-obtain its sounds after their share was revoked, since they kept the
 * hashes. Gating the branch on `added_by IS NULL` looked like a fix and was
 * not: an anonymous link-share write records no adder (`route.ts` passes
 * `loaded.user?.id ?? null`), and an attacker can make one of those on their
 * own profile.
 *
 * The cost is that a row with no recorded adder is now refused even to the
 * owner — migration 2's backfill, and anything published through an anonymous
 * link share. `reindexProfileAudio` is INSERT OR IGNORE, so a re-save does not
 * fill the column in. Serving those safely needs a grant the owner cannot
 * manufacture, which means share acceptance. See audioShareGrant.test.ts.
 *
 * The `profile_audio.added_by` branch is what makes the answer stable. Deriving
 * it from the live share table alone was wrong twice: a link share has
 * `email IS NULL` by schema constraint so it never joined — a sound added by a
 * link-share editor was 404 for everyone including the owner — and reading live
 * shares made the grant retroactive, so revoking a share silenced pads a
 * departed collaborator had contributed to the owner's own board. Whether a
 * sound could legitimately be here is a fact about the past. The email-share
 * branch stays for rows written before that column existed.
 *
 * Naming a hash in a blob still buys nothing: `added_by` only helps someone who
 * genuinely holds a reference to the sound, and a reference costs proof of
 * possession.
 */
export function profileMayServeHash(
  profileId: string,
  ownerId: number,
  hash: string,
): boolean {
  return (
    queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM audio_references r
        WHERE r.hash = ?
          AND (
            r.user_id = ?
            OR r.user_id IN (
              SELECT pa.added_by
                FROM profile_audio pa
               WHERE pa.profile_id = ? AND pa.hash = ? AND pa.added_by IS NOT NULL
            )
          )
        LIMIT 1`,
      hash,
      ownerId,
      profileId,
      hash,
    ) !== undefined
  );
}

/**
 * The key an object lives under, honouring the extension it was *stored*
 * with rather than the one this caller happens to be using.
 *
 * Keys are content-addressed but carry an extension, so the same bytes named
 * `kick.mp3` and `kick` produced two different keys. The second uploader was
 * told the bytes were already stored — true, the hash was known — handed no
 * upload URL, and then 404'd at commit against a key nothing had ever written.
 * They could never host that file.
 */
export function storageKeyForHash(
  hash: string,
  fallbackExtension: string,
): string {
  return objectKeyForHash(
    hash,
    getAudioObject(hash)?.extension ?? fallbackExtension,
  );
}

/**
 * Whether a profile *this user can reach* still names this sound.
 *
 * Deleting from a library used to drop the bucket object the moment the last
 * *reference* went, without asking whether a board still played it — so an
 * owner tidying their library could make their own live profile 404.
 *
 * Scoped to the holder's own profiles and the ones shared with their email
 * address, because the unscoped version was a denial of service. profile_audio
 * is rebuilt from whatever a writer puts in `data`, and any signed-in account
 * may create a profile naming any hash, so a stranger could permanently freeze
 * someone else's storage allowance and stop them deleting their own file — with
 * no way for the victim to see who had done it, the squatting profile being
 * invisible to them. A third party's board is not a board this caller is about
 * to silence.
 *
 * Link shares are deliberately not counted: holding a link grants access to one
 * profile, not membership of it, and there is no way to enumerate them for a
 * user anyway (see listProfilesForUser).
 */
export function hashIsUsedByReachableProfile(
  hash: string,
  userId: number,
  email: string,
): boolean {
  return (
    queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM profile_audio pa
         JOIN profiles p ON p.id = pa.profile_id
        WHERE pa.hash = ?
          AND (
            p.owner_id = ?
            OR EXISTS (
              SELECT 1 FROM profile_shares s
               WHERE s.profile_id = p.id AND s.email = ?
            )
          )
        LIMIT 1`,
      hash,
      userId,
      email,
    ) !== undefined
  );
}

export type UploadDecision =
  | { allowed: true; alreadyStored: boolean }
  | {
      allowed: false;
      reason: "not_approved" | "too_large" | "user_quota" | "global_cap";
      /** Filled in for the quota refusals, so the UI can be specific. */
      detail?: { usedBytes: number; limitBytes: number };
    };

/**
 * Decide whether `userId` may upload `sizeBytes`, before any URL is minted.
 *
 * An object that is already stored costs nothing new globally, and costs the
 * user nothing either if they already hold a reference to it — so re-adding a
 * sound you already have never fails on quota.
 */
export function canUpload({
  userId,
  canUploadAudio,
  hash,
  sizeBytes,
  quotaBytes,
  capBytes,
  maxObjectBytes,
}: {
  userId: number;
  canUploadAudio: boolean;
  hash: string;
  sizeBytes: number;
  quotaBytes: number;
  capBytes: number;
  maxObjectBytes: number;
}): UploadDecision {
  if (!canUploadAudio) return { allowed: false, reason: "not_approved" };

  // Checked before the size ceiling on purpose: re-adding a sound the user
  // already holds changes nothing, and must not start failing because the
  // deployment lowered maxObjectBytes after they uploaded it.
  //
  // "Changes nothing" has to be verified, not assumed. A presigned PUT signs
  // only `host`, so the holder can overwrite the object with something far
  // larger and commit again; skipping the checks then let the new size be
  // recorded straight past the ceiling and the quota, which is the very thing
  // charging from the bucket at commit exists to prevent. A different size
  // means different bytes, so it goes through the full decision.
  const existing = getAudioObject(hash);
  if (
    existing &&
    existing.size_bytes === sizeBytes &&
    userHoldsReference(userId, hash)
  ) {
    return { allowed: true, alreadyStored: true };
  }

  if (sizeBytes > maxObjectBytes)
    return { allowed: false, reason: "too_large" };

  // Charged size is what the object really is, when we already know it.
  const chargedBytes = existing?.size_bytes ?? sizeBytes;

  const user = getUserUsage(userId, quotaBytes);
  if (user.usedBytes + chargedBytes > quotaBytes) {
    return {
      allowed: false,
      reason: "user_quota",
      detail: { usedBytes: user.usedBytes, limitBytes: quotaBytes },
    };
  }

  // A blob already in the bucket adds nothing to the global total.
  if (!existing) {
    const global = getGlobalUsage(capBytes);
    if (global.usedBytes + sizeBytes > capBytes) {
      return {
        allowed: false,
        reason: "global_cap",
        detail: { usedBytes: global.usedBytes, limitBytes: capBytes },
      };
    }
  }

  return { allowed: true, alreadyStored: existing !== undefined };
}

/**
 * Record an object and the uploader's reference to it, once the bytes are
 * known to be in the bucket. Idempotent: committing twice is a no-op, which
 * matters because a client that retries a flaky commit must not be charged
 * twice or see an error.
 */
export function recordUpload({
  userId,
  hash,
  sizeBytes,
  contentType,
  extension,
  name,
}: {
  userId: number;
  hash: string;
  sizeBytes: number;
  contentType: string;
  extension: string;
  name: string;
}): void {
  const now = Date.now();
  transaction(() => {
    execute(
      `INSERT INTO audio_objects (hash, size_bytes, content_type, extension, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET size_bytes = excluded.size_bytes`,
      hash,
      sizeBytes,
      contentType,
      extension,
      now,
    );
    execute(
      `INSERT INTO audio_references (user_id, hash, name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, hash) DO UPDATE SET name = excluded.name`,
      userId,
      hash,
      name,
      now,
    );
  });
}

/**
 * Drop a user's reference. Reports whether the object is now unreferenced and
 * so should be removed from the bucket — the caller does that, because it is
 * a network call and this module only touches the database.
 */
export function releaseReference(
  userId: number,
  hash: string,
): { removed: boolean; orphaned: boolean } {
  return transaction(() => {
    const result = execute(
      "DELETE FROM audio_references WHERE user_id = ? AND hash = ?",
      userId,
      hash,
    );
    if (result.changes === 0) return { removed: false, orphaned: false };

    const remaining = queryOne<{ count: number }>(
      "SELECT COUNT(*) AS count FROM audio_references WHERE hash = ?",
      hash,
    );
    const orphaned = (remaining?.count ?? 0) === 0;
    if (orphaned) {
      execute("DELETE FROM audio_objects WHERE hash = ?", hash);
    }
    return { removed: true, orphaned };
  });
}

/** Everything a user holds, newest first. */
export function listUserAudio(userId: number) {
  return queryAll<{
    hash: string;
    name: string;
    size_bytes: number;
    content_type: string;
    extension: string;
    created_at: number;
  }>(
    `SELECT o.hash, r.name, o.size_bytes, o.content_type, o.extension, r.created_at
       FROM audio_references r
       JOIN audio_objects o ON o.hash = r.hash
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC`,
    userId,
  );
}
