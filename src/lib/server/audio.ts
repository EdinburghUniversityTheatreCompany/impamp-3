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
  const existing = getAudioObject(hash);
  if (existing && userHoldsReference(userId, hash)) {
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
