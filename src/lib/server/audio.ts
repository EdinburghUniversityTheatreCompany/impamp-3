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

/**
 * Which of `hashes` have an `audio_objects` row, in one query.
 *
 * The sweep asks this of a whole page of bucket keys at a time. Asking per
 * object would be a synchronous SQLite round trip per key on the thread that
 * serves requests, which is what kept the sweep's per-pass budget small enough
 * to be useless.
 *
 * A range rather than an `IN` list because `db.ts` caches prepared statements
 * by their SQL text and documents every string in the codebase as a literal;
 * an `IN` with a placeholder per hash would put one entry per page size in
 * that cache. The range costs nothing extra: a bucket key is
 * `audio/<first two hex of the hash>/<hash>`, so a page of keys — contiguous
 * in the bucket's own lexicographic order — is a contiguous range of hashes,
 * and the rows between the lowest and the highest are that page and its
 * neighbours' near misses, not the whole table.
 *
 * It answers in **keys, not hashes**, and that is the whole point of it. Keys
 * are content-addressed but carry an extension, and before a commit exists
 * `storageKeyForHash` has nothing to honour but the extension the caller
 * declared — so the same bytes offered as `horn.wav` and `horn.mp3` mint two
 * keys, one of which is then abandoned. Answering "is this hash committed"
 * protects both, so the abandoned one survives every pass forever: quota sums
 * `audio_objects` and so does the admin view, and no API takes a key, which
 * makes the sweep the only thing that could ever have reached it. Answering
 * "is this the key its row names" collects it, and still keeps an object whose
 * row exists — the two cases the sweep has to tell apart fall out of one
 * membership test.
 *
 * @returns The keys, among rows for `hashes`, that a committed row names.
 *   Empty in, empty out — never "everything".
 */
export function committedKeysAmong(hashes: string[]): Set<string> {
  if (hashes.length === 0) return new Set();

  let lowest = hashes[0];
  let highest = hashes[0];
  for (const hash of hashes) {
    if (hash < lowest) lowest = hash;
    if (hash > highest) highest = hash;
  }

  const wanted = new Set(hashes);
  const rows = queryAll<{ hash: string; extension: string }>(
    "SELECT hash, extension FROM audio_objects WHERE hash >= ? AND hash <= ?",
    lowest,
    highest,
  );

  return new Set(
    rows
      .filter((row) => wanted.has(row.hash))
      .map((row) => objectKeyForHash(row.hash, row.extension)),
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
 * Whether dropping this user's reference would silence a board that plays it.
 *
 * Deleting from a library used to drop the bucket object the moment the last
 * *reference* went, without asking whether a board still played it — so an
 * owner tidying their library could make their own live profile 404.
 *
 * The question is asked from the other end now: not "does some profile name
 * this sound", but "is this caller's reference what serves it". Those are the
 * same two facts `profileMayServeHash` decides a download on — a profile can
 * play a sound when its owner holds a reference to it, or when whoever
 * attached it does — so the two functions agree by construction, and a delete
 * can only be refused when it would really take a pad away.
 *
 * The scope used to be "profiles you own or have been shared", and that was a
 * denial of service with an extra step. `profile_audio` is rebuilt from
 * whatever a writer puts in `data`, any signed-in account may create a profile
 * naming any hash, and `upsertEmailShare` writes an invitation for any address
 * on the inviter's say-so with no acceptance step and no notification. So a
 * stranger could name your hash in a board of their own, invite you to it, and
 * pin your file and its share of your allowance permanently — in a profile you
 * never asked for, cannot see listed as the cause, and cannot make them
 * delete. Ownership and `added_by` are both facts about the past that nobody
 * else can write on your behalf, which is what makes them safe to read here.
 *
 * The `NOT EXISTS` is the fail-open half: when somebody else who could serve
 * that board still holds the bytes — the owner's own copy of a sound their
 * collaborator also uploaded — this reference is not load-bearing and there is
 * nothing to protect by refusing.
 *
 * Membership of any kind has stopped being part of the answer, which is what
 * makes link shares a non-question here: a signed-in writer using a link is
 * recorded as the adder exactly like anyone else, and an anonymous one records
 * nothing because there is no account to record.
 */
export function deletingHashWouldSilenceAProfile(
  userId: number,
  hash: string,
): boolean {
  return (
    queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM profile_audio pa
         JOIN profiles p ON p.id = pa.profile_id
        WHERE pa.hash = ?
          AND (p.owner_id = ? OR pa.added_by = ?)
          AND NOT EXISTS (
            SELECT 1
              FROM audio_references r
             WHERE r.hash = pa.hash
               AND r.user_id <> ?
               AND (r.user_id = p.owner_id OR r.user_id = pa.added_by)
          )
        LIMIT 1`,
      hash,
      userId,
      userId,
      userId,
    ) !== undefined
  );
}

/**
 * Bytes a presigned PUT has been licensed to write but nothing has committed.
 *
 * `upload-url` mints a URL and returns; the object is not recorded until
 * commit. Between the two, the bytes can be in the bucket while every total
 * that exists — `getUserUsage`, `getGlobalUsage`, the admin view — sums
 * `audio_objects` and therefore cannot see them. A caller who PUTs and never
 * commits was storing for free, once per invented hash, with no bound but the
 * sweep an admin has to trigger by opening a page.
 *
 * So a mint is recorded and provisionally charged. Two properties keep that
 * from turning into a lockout, which is the failure that matters more here —
 * this app is used to run shows, and a refused upload lands on somebody in a
 * theatre:
 *
 * - **One row per user per hash.** A client retrying the same file replaces
 *   its own row rather than being charged again for it.
 * - **Charged only while the URL could still be used.** Past
 *   `uploadUrlTtlSeconds` the presign is dead, so the charge lapses and the
 *   row is pruned. The bytes may still be in the bucket until the sweep gets
 *   to them; that is the sweep's job, not the quota's, and metering them for
 *   longer would freeze an allowance over an upload that failed.
 *
 * The size is the client's claim, which is all anyone has before the bytes
 * land. Commit still measures the object and re-decides against the real
 * number — a presigned PUT signs only `host`, so nothing here can constrain
 * what is actually sent.
 */
export function recordPendingUpload({
  userId,
  hash,
  sizeBytes,
  now = Date.now(),
}: {
  userId: number;
  hash: string;
  sizeBytes: number;
  now?: number;
}): void {
  execute(
    `INSERT INTO audio_pending_uploads (user_id, hash, size_bytes, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, hash)
     DO UPDATE SET size_bytes = excluded.size_bytes, created_at = excluded.created_at`,
    userId,
    hash,
    sizeBytes,
    now,
  );
}

/** Drop a mint's provisional charge: it committed, or its URL has expired. */
export function clearPendingUpload(userId: number, hash: string): void {
  execute(
    "DELETE FROM audio_pending_uploads WHERE user_id = ? AND hash = ?",
    userId,
    hash,
  );
}

/** Forget every mint whose presigned URL can no longer be used. */
export function prunePendingUploads(since: number): void {
  execute("DELETE FROM audio_pending_uploads WHERE created_at < ?", since);
}

/**
 * What this user's live mints add to their usage, ignoring `hash`.
 *
 * `hash` is the upload being decided, whose own row must not count against it
 * — otherwise re-asking for a URL after a failed PUT would charge twice and
 * eventually refuse the retry. Hashes the user already holds a reference to
 * are ignored for the same reason from the other side: those bytes are in
 * `getUserUsage` already.
 */
function pendingBytesForUser(
  userId: number,
  hash: string,
  since: number,
): number {
  return (
    queryOne<{ bytes: number | null }>(
      `SELECT COALESCE(SUM(p.size_bytes), 0) AS bytes
         FROM audio_pending_uploads p
        WHERE p.user_id = ?
          AND p.hash <> ?
          AND p.created_at >= ?
          AND NOT EXISTS (
            SELECT 1 FROM audio_references r
             WHERE r.user_id = p.user_id AND r.hash = p.hash
          )`,
      userId,
      hash,
      since,
    )?.bytes ?? 0
  );
}

/**
 * What every live mint adds to the bucket's total, ignoring `hash`.
 *
 * Counted once per hash however many people are uploading it, because the
 * bucket holds one object either way — and never for a hash already in
 * `audio_objects`, which `getGlobalUsage` counts.
 */
function pendingBytesGlobally(hash: string, since: number): number {
  return (
    queryOne<{ bytes: number | null }>(
      `SELECT COALESCE(SUM(size), 0) AS bytes
         FROM (
           SELECT MAX(p.size_bytes) AS size
             FROM audio_pending_uploads p
            WHERE p.hash <> ?
              AND p.created_at >= ?
              AND NOT EXISTS (
                SELECT 1 FROM audio_objects o WHERE o.hash = p.hash
              )
            GROUP BY p.hash
         )`,
      hash,
      since,
    )?.bytes ?? 0
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
  pendingSince = Date.now(),
}: {
  userId: number;
  canUploadAudio: boolean;
  hash: string;
  sizeBytes: number;
  quotaBytes: number;
  capBytes: number;
  maxObjectBytes: number;
  /**
   * The oldest mint still worth charging for — `now - uploadUrlTtlSeconds`.
   * Defaults to now, which counts nothing: a caller that does not know the
   * TTL decides on committed bytes alone, exactly as this used to.
   */
  pendingSince?: number;
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
  // Plus what this user has already been licensed to write and not committed.
  // Without it the quota bounded nothing: ask for a URL, do not commit, ask
  // again, and every ask was decided against the same unchanged total.
  const userPending = pendingBytesForUser(userId, hash, pendingSince);
  if (user.usedBytes + userPending + chargedBytes > quotaBytes) {
    return {
      allowed: false,
      reason: "user_quota",
      // The used figure stays the committed one, because that is what the
      // client shows next to the allowance and what deleting a file changes.
      detail: { usedBytes: user.usedBytes, limitBytes: quotaBytes },
    };
  }

  // A blob already in the bucket adds nothing to the global total.
  if (!existing) {
    const global = getGlobalUsage(capBytes);
    const globalPending = pendingBytesGlobally(hash, pendingSince);
    if (global.usedBytes + globalPending + sizeBytes > capBytes) {
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
    // The mint this commit was for is no longer provisional — it is in
    // `audio_objects` now, where every total can see it. Leaving the row would
    // charge the same bytes twice until it lapsed.
    clearPendingUpload(userId, hash);
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
